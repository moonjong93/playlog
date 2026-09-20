import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";
import { displaySourceName } from "../src/pages/layout.ts";

afterAll(() => cleanup());

/** 사용자 반응 섹션만 잘라낸다(뒤따르는 출처 섹션 전까지). */
function communitySection(html: string): string {
  const start = html.indexOf("사용자 반응");
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

describe("displaySourceName", () => {
  it("피드 꼬리표 (top/day) 를 떼어낸다", () => {
    expect(displaySourceName("Reddit r/Games (top/day)")).toBe("Reddit r/Games");
    expect(displaySourceName("Reddit r/pcgaming (top/week)")).toBe(
      "Reddit r/pcgaming",
    );
    expect(displaySourceName("  Reddit r/Games (top/day)  ")).toBe("Reddit r/Games");
  });

  it("다른 모양은 그대로 둔다", () => {
    expect(displaySourceName("Famitsu")).toBe("Famitsu");
    expect(displaySourceName("PlayStation Blog")).toBe("PlayStation Blog");
    expect(displaySourceName("Reddit r/Games")).toBe("Reddit r/Games");
  });
});

describe("사용자 반응", () => {
  it("번역문을 - 불릿으로 렌더하고 작성자 이름은 쓰지 않는다", async () => {
    const html = await (await app.request("/s/community-translated")).text();
    const section = communitySection(html);
    expect(section).toContain("이 게임 정말 기대된다.");
    expect(section).toContain("닉네임 없는 번역 댓글");
    expect(section).not.toContain("u/SomeUser");
    expect(section).not.toContain("u/anon");
    expect(section).not.toContain("r/Games");
    // 불릿 기호
    expect((section.match(/>\s*-\s*<\/span>/g) ?? []).length).toBe(3);
  });

  it("출처 목록에는 (top/day) 꼬리표가 보이지 않는다", async () => {
    const html = await (await app.request("/s/community-translated")).text();
    expect(html).not.toContain("(top/day)");
    expect(html).toContain("Reddit r/Games");
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
    expect((section.match(/>\s*-\s*<\/span>/g) ?? []).length).toBe(6);
  });
});
