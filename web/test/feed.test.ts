import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

beforeAll(() => {
  for (let i = 1; i <= 25; i += 1) {
    const n = String(i).padStart(2, "0");
    insertArticle({
      slug: `page-${n}`,
      title: `페이지 기사 ${n}`,
      section: i <= 3 ? "ship" : "announce",
      publishedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - i * 60_000).toISOString(),
    });
  }
});

afterAll(() => cleanup());

function cards(html: string): string[] {
  return html.match(/class="feed-card/g) ?? [];
}

describe("피드/기사", () => {
  it("피드 첫 페이지는 20건", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(cards(html).length).toBe(20);
    expect(html).toContain("페이지 기사 01");
    expect(html).toContain("25건");
    expect(html).not.toContain("페이지 기사 21");
  });

  it("2페이지는 나머지 5건", async () => {
    const html = await (await app.request("/?page=2")).text();
    expect(cards(html).length).toBe(5);
    expect(html).toContain("페이지 기사 21");
    expect(html).not.toContain("페이지 기사 01");
  });

  it("페이지 번호 링크가 있다", async () => {
    const html = await (await app.request("/")).text();
    expect(html).toContain('href="/?page=2"');
    expect(html).toContain(">다음<");
  });

  it("섹션 필터가 동작한다", async () => {
    const html = await (await app.request("/?section=ship")).text();
    expect(cards(html).length).toBe(3);
    expect(html).toContain("페이지 기사 01");
    expect(html).not.toContain("페이지 기사 04");

    const other = await (await app.request("/?section=review")).text();
    expect(cards(other).length).toBe(0);
    expect(other).toContain("아직 기사가 없습니다");
  });

  it("섹션 탭은 전체 + 5개 섹션", async () => {
    const html = await (await app.request("/")).text();
    for (const label of ["전체", "업계·사업", "발표·신작", "출시·패치", "발언", "리뷰·공략"]) {
      expect(html).toContain(label);
    }
  });

  it("없는 기사는 404 안내", async () => {
    const res = await app.request("/s/없는-기사");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("기사를 찾을 수 없습니다");
  });

  it("기사 상세 상단에 OG/ canonical 메타가 있다", async () => {
    const html = await (await app.request("/s/page-01")).text();
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('<meta property="article:published_time"');
    expect(html).toContain('<link rel="canonical" href="/s/page-01" />');
  });
});
