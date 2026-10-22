import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

const src = (name: string) => ({
  name,
  url: `https://example.com/${name.toLowerCase()}`,
  role: "primary",
});
const one = [src("A")];
const two = [src("A"), src("B")];
const three = [src("A"), src("B"), src("C")];
/** MIN_BODY_CHARS(900) 를 넘는 본문. */
const longBody = `<p>${"가".repeat(1200)}</p>`;
const NOINDEX = /<meta name="robots" content="noindex, follow"/;

beforeAll(() => {
  insertArticle({ slug: "thin-one", tags: ["얇은태그"], sources: one });
  insertArticle({ slug: "no-sources", sources: [] });
  insertArticle({ slug: "multi-source", tags: ["풍부태그"], sources: three });
  insertArticle({ slug: "long-body", tags: ["풍부태그"], body: longBody, sources: one });
  // 풍부태그가 MIN_TAG_ARTICLES(8) 를 넘도록 색인 대상 기사를 채운다.
  for (let i = 1; i <= 6; i += 1) {
    insertArticle({ slug: `bulk-${i}`, tags: ["풍부태그"], sources: three });
  }
});
afterAll(() => cleanup());

describe("색인 기준", () => {
  it("출처 2개 이하 + 짧은 본문 기사는 noindex, 사이트맵에서 제외", async () => {
    const html = await (await app.request("/s/thin-one")).text();
    expect(html).toMatch(NOINDEX);
    expect((await app.request("/s/thin-one")).status).toBe(200);
    expect(await (await app.request("/s/no-sources")).text()).toMatch(NOINDEX);
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).not.toContain("/s/thin-one<");
    expect(xml).not.toContain("/s/no-sources<");
  });

  it("출처 3개 이상 또는 본문 900자 이상이면 색인 대상", async () => {
    for (const slug of ["multi-source", "long-body"]) {
      expect(await (await app.request(`/s/${slug}`)).text()).not.toMatch(NOINDEX);
    }
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).toContain("/s/multi-source<");
    expect(xml).toContain("/s/long-body<");
  });

  it("출처 2개는 더 이상 색인 대상이 아니다", async () => {
    insertArticle({ slug: "two-sources", sources: two });
    expect(await (await app.request("/s/two-sources")).text()).toMatch(NOINDEX);
    expect(await (await app.request("/sitemap.xml")).text()).not.toContain("/s/two-sources<");
  });

  it("색인 기사 8건 미만 태그는 noindex + 사이트맵 제외, 이상이면 색인", async () => {
    const thin = await (await app.request(`/?tag=${encodeURIComponent("얇은태그")}`)).text();
    expect(thin).toMatch(NOINDEX);
    const rich = await (await app.request(`/?tag=${encodeURIComponent("풍부태그")}`)).text();
    expect(rich).not.toMatch(NOINDEX);
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).not.toContain(encodeURIComponent("얇은태그"));
    expect(xml).toContain(`?tag=${encodeURIComponent("풍부태그")}</loc>`);
  });

  it("2페이지부터의 목록은 중복이라 noindex", async () => {
    expect(await (await app.request("/?page=2")).text()).toMatch(NOINDEX);
    expect(await (await app.request("/tags?page=2")).text()).toMatch(NOINDEX);
    expect(await (await app.request("/?page=1")).text()).not.toMatch(NOINDEX);
    expect(await (await app.request("/tags")).text()).not.toMatch(NOINDEX);
  });

  it("뉴스 사이트맵에도 얇은 기사는 빠진다", async () => {
    const now = new Date().toISOString();
    insertArticle({ slug: "fresh-thin", publishedAt: now, sources: one });
    insertArticle({ slug: "fresh-rich", publishedAt: now, sources: three });
    const xml = await (await app.request("/sitemap-news.xml")).text();
    expect(xml).toContain("/s/fresh-rich<");
    expect(xml).not.toContain("/s/fresh-thin<");
  });

  it("홈과 피드 목록·RSS는 얇은 기사도 그대로 보여준다", async () => {
    expect(await (await app.request("/")).text()).toContain("thin-one");
    expect(await (await app.request("/rss.xml")).text()).toContain("thin-one");
  });
});
