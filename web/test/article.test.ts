import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";
import { communitySourceLabel } from "../src/pages/article.ts";

afterAll(() => cleanup());

/** 커뮤니티 반응 섹션만 잘라낸다(뒤따르는 출처 섹션 전까지). */
function communitySection(html: string): string {
  const start = html.indexOf("커뮤니티 반응");
  if (start === -1) return "";
  const end = html.indexOf("출처", start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

const SCRIPT_PAYLOAD = `<script>alert("x")</script>`;

beforeAll(() => {
  insertArticle({
    slug: "community-translated",
    title: "번역 댓글 표시",
    sources: [
      {
        name: "Reddit r/Games (top/day)",
        url: "https://www.reddit.com/r/Games/comments/abc",
        role: "community",
        comments: [
          { author: "SomeUser", text: "이 게임 정말 기대된다." },
          { author: "", text: "닉네임 없는 번역 댓글" },
          { author: "evil_user", text: SCRIPT_PAYLOAD },
        ],
      },
      {
        name: "Famitsu",
        url: "https://example.com/famitsu",
        role: "primary",
        comments: [
          { author: "famitsu_user", text: "패미통에도 비슷한 반응이 있었다." },
        ],
      },
    ],
  });
  insertArticle({
    slug: "community-cap",
    title: "댓글 상한",
    sources: [
      {
        name: "Reddit r/Games (top/day)",
        url: "https://www.reddit.com/r/Games/comments/cap",
        role: "community",
        comments: Array.from({ length: 6 }, (_, i) => ({
          author: `cap_user_${i + 1}`,
          text: `상한 안쪽 번역 댓글 ${i + 1}`,
        })),
      },
      {
        name: "Reddit r/pcgaming (top/day)",
        url: "https://www.reddit.com/r/pcgaming/comments/cap",
        role: "community",
        comments: [
          { author: "over_user_1", text: "상한 밖 번역 댓글 1" },
          { author: "over_user_2", text: "상한 밖 번역 댓글 2" },
        ],
      },
    ],
  });
});

describe("communitySourceLabel", () => {
  it("Reddit 접두와 꼬리 괄호를 떼어낸다", () => {
    expect(communitySourceLabel("Reddit r/Games (top/day)")).toBe("r/Games");
    expect(communitySourceLabel("Reddit r/pcgaming (top/week)")).toBe("r/pcgaming");
    expect(communitySourceLabel("  Reddit r/Games (top/day)  ")).toBe("r/Games");
  });

  it("모양이 다르면 원문 그대로 둔다", () => {
    expect(communitySourceLabel("Famitsu")).toBe("Famitsu");
    expect(communitySourceLabel("Reddit r/Games")).toBe("Reddit r/Games");
    expect(communitySourceLabel("r/Games (top/day)")).toBe("r/Games (top/day)");
    expect(communitySourceLabel(undefined)).toBe("");
  });
});

describe("커뮤니티 반응 카드", () => {
  it("번역문·작성자·짧은 소스 라벨을 댓글 카드로 렌더한다", async () => {
    const html = await (await app.request("/s/community-translated")).text();
    const section = communitySection(html);
    expect(section).toContain("이 게임 정말 기대된다.");
    expect(section).toContain("u/SomeUser");
    expect(section).toContain("u/anon");
    expect(section).toContain("u/famitsu_user");
    expect(section).toContain("패미통에도 비슷한 반응이 있었다.");
    expect(section).toContain("r/Games");
    expect(section).not.toContain("Reddit r/Games (top/day)");
    expect(section).toContain(
      "bg-surface-container-low border border-outline-variant rounded p-3.5",
    );
    // 출처 목록은 줄이지 않은 이름 그대로 유지된다.
    expect(html).toContain("Reddit r/Games (top/day)");
  });

  it("댓글 본문의 HTML은 이스케이프된다", async () => {
    const html = await (await app.request("/s/community-translated")).text();
    expect(html).not.toContain(SCRIPT_PAYLOAD);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("전체 6개를 넘는 댓글은 렌더하지 않는다", async () => {
    const html = await (await app.request("/s/community-cap")).text();
    const section = communitySection(html);
    expect(section).toContain("상한 안쪽 번역 댓글 6");
    expect(section).not.toContain("상한 밖 번역 댓글 1");
    expect(section).not.toContain("상한 밖 번역 댓글 2");
    expect((section.match(/u\/cap_user_/g) ?? []).length).toBe(6);
  });
});
