import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

beforeAll(() => {
  for (let i = 1; i <= 25; i += 1) {
    const n = String(i).padStart(2, "0");
    insertArticle({
      slug: `page-${n}`,
      title: `페이지 기사 ${n}`,
      tags: [i <= 3 ? "출시·패치" : "발표·신작"],
      publishedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - i * 60_000).toISOString(),
    });
  }
});

afterAll(() => cleanup());

function cards(html: string): string[] {
  return html.match(/class="feed-card/g) ?? [];
}

function headerNav(html: string): string {
  const start = html.indexOf('aria-label="태그"');
  const end = html.indexOf("</nav>", start);
  return html.slice(start, end);
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

  it("태그 필터가 동작한다", async () => {
    const html = await (await app.request(`/?tag=${encodeURIComponent("출시·패치")}`)).text();
    expect(cards(html).length).toBe(3);
    expect(html).toContain("페이지 기사 01");
    expect(html).not.toContain("페이지 기사 04");

    const other = await (await app.request(`/?tag=${encodeURIComponent("리뷰·공략")}`)).text();
    expect(cards(other).length).toBe(0);
    expect(other).toContain("태그의 기사가 없습니다");
    expect(other).toContain("0건");
  });

  it("?section= 은 더 이상 필터가 아니다", async () => {
    const all = await (await app.request("/")).text();
    const sectioned = await (await app.request("/?section=ship")).text();
    expect(cards(sectioned).length).toBe(cards(all).length);
    expect(sectioned).toContain("25건");
  });

  it("카드 칩은 /?tag= 로 링크한다", async () => {
    const html = await (await app.request("/")).text();
    expect(html).toContain(`href="/?tag=${encodeURIComponent("출시·패치")}"`);
  });

  it("네비는 최근 태그와 전체보기 링크다", async () => {
    const html = await (await app.request("/")).text();
    const nav = headerNav(html);
    expect(nav).toContain("#출시·패치");
    expect(nav).toContain("#발표·신작");
    expect(nav).toContain('href="/tags"');
    expect(nav).toContain("전체보기");
    expect(nav).not.toContain("?section=");
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

  it("태그 피드 canonical에 태그가 들어간다", async () => {
    const hash = encodeURIComponent("출시·패치");
    const html = await (await app.request(`/?tag=${hash}`)).text();
    expect(html).toContain(`<link rel="canonical" href="/?tag=${hash}" />`);
  });
});
