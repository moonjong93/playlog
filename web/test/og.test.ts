import { afterAll, describe, expect, it } from "vitest";
import { cleanup } from "./helpers.ts";
import { logoPng, manifestJson } from "../src/brand.ts";
import { articleOgCard, cleanOgText, creditLabel, defaultOgCard, ogBullets } from "../src/og.ts";

afterAll(() => cleanup());

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe("OG 카드 텍스트", () => {
  it("이모지·변형 선택자를 지우고 공백을 정리한다", () => {
    expect(cleanOgText("신작   공개 🎮  확정")).toBe("신작 공개 확정");
    expect(cleanOgText("A\uFE0F B")).toBe("A B");
    expect(cleanOgText("줄\n바꿈\t섞임")).toBe("줄 바꿈 섞임");
  });

  it("리드 요약을 불릿으로 쓰고 최대 3줄로 자른다", () => {
    const lede = ["첫 줄 요약", "둘째 줄 요약", "셋째 줄 요약", "넷째 줄 요약"].join("\n");
    expect(ogBullets(lede)).toEqual(["첫 줄 요약", "둘째 줄 요약", "셋째 줄 요약"]);
  });

  it("리드가 없으면 본문 평문에서 문장을 뽑는다", () => {
    const body = "첫 번째 문장이다. 두 번째 문장이다. 세 번째 문장이다.";
    const bullets = ogBullets("", body);
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets[0]).toContain("첫 번째 문장");
  });

  it("긴 불릿은 말줄임표로 줄인다", () => {
    const long = "가".repeat(200);
    const [bullet] = ogBullets(long);
    expect([...bullet].length).toBeLessThanOrEqual(96);
    expect(bullet.endsWith("…")).toBe(true);
  });

  it("기사 카드는 KST 날짜와 태그를 담는다", () => {
    const card = articleOgCard({
      title_ko: "제목",
      lede_ko: "요약입니다.",
      body_html: "<p>본문입니다.</p>",
      sources_json: "[]",
      published_at: "2026-09-19T23:30:00Z",
      tags: ["태그1", "태그2", "태그3", "태그4"],
    });
    // 2026-09-19T23:30Z = 2026-09-20 08:30 KST
    expect(card.meta).toBe("2026.09.20");
    expect(card.tags).toHaveLength(4);
    expect(card.bullets).toEqual(["요약입니다."]);
  });

  it("출처 표기는 중복을 합치고 3개부터 +N 으로 줄인다", () => {
    const sources = JSON.stringify([
      { name: "IGN", url: "https://ign.com/a" },
      { name: "IGN", url: "https://ign.com/b" },
      { name: "PC Gamer", url: "https://pcgamer.com/a" },
      { name: "Push Square", url: "https://pushsquare.com/a" },
      { name: "Reddit r/Games (top/day)", url: "https://reddit.com/r/games" },
    ]);
    expect(creditLabel(sources)).toBe("IGN, PC Gamer +2");
    expect(creditLabel("[]")).toBe("");
    expect(creditLabel("[{\"url\":\"https://www.4gamer.net/x\"}]")).toBe("4gamer.net");
  });

  it("기본 카드는 사이트 소개 문구를 쓴다", () => {
    const card = defaultOgCard();
    expect(card.title).toContain("게임 업계 뉴스");
    expect(card.bullets.length).toBe(3);
    expect(card.meta).not.toBe("");
  });
});

describe("아이콘", () => {
  it("로고 PNG는 PNG 시그니처로 시작한다", () => {
    const png = logoPng(192);
    expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(logoPng(192)).toBe(png); // 캐시
    // 클립/그라디언트가 깨져 빈 이미지가 나오면 훨씬 작아진다.
    expect(logoPng(512).length).toBeGreaterThan(2000);
  });

  it("매니페스트는 이름과 아이콘을 담는다", () => {
    const manifest = JSON.parse(manifestJson());
    expect(manifest.name).toBe("PLAYLOG");
    expect(manifest.icons).toHaveLength(2);
  });
});
