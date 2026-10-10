import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

const two = [
  { name: "A", url: "https://example.com/a", role: "primary" },
  { name: "B", url: "https://example.com/b", role: "support" },
];
const one = [{ name: "A", url: "https://example.com/a", role: "primary" }];
const longBody = `<p>${"가".repeat(520)}</p>`;
const NOINDEX = /<meta name="robots" content="noindex, follow"/;

beforeAll(() => {
  insertArticle({ slug: "thin-one", tags: ["얇은태그"], sources: one });
  insertArticle({ slug: "multi-source", tags: ["풍부태그"], sources: two });
  insertArticle({ slug: "long-body", tags: ["풍부태그"], body: longBody, sources: one });
  insertArticle({ slug: "multi-2", tags: ["풍부태그"], sources: two });
  insertArticle({ slug: "no-sources", sources: [] });
});
afterAll(() => cleanup());

describe("색인 기준", () => {
  it("출처 1개 + 짧은 본문 기사는 noindex, 사이트맵에서 제외", async () => {
    const html = await (await app.request("/s/thin-one")).text();
    expect(html).toMatch(NOINDEX);
    expect((await app.request("/s/thin-one")).status).toBe(200);
    expect(await (await app.request("/s/no-sources")).text()).toMatch(NOINDEX);
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).not.toContain("/s/thin-one<");
    expect(xml).not.toContain("/s/no-sources<");
  });

  it("출처 2개 이상 또는 본문 500자 이상이면 색인 대상", async () => {
    for (const slug of ["multi-source", "long-body"]) {
      expect(await (await app.request(`/s/${slug}`)).text()).not.toMatch(NOINDEX);
    }
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).toContain("/s/multi-source<");
    expect(xml).toContain("/s/long-body<");
  });

  it("색인 기사 3건 미만 태그는 noindex + 사이트맵 제외, 이상이면 색인", async () => {
    const thin = await (await app.request(`/?tag=${encodeURIComponent("얇은태그")}`)).text();
    expect(thin).toMatch(NOINDEX);
    const rich = await (await app.request(`/?tag=${encodeURIComponent("풍부태그")}`)).text();
    expect(rich).not.toMatch(NOINDEX);
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).not.toContain(encodeURIComponent("얇은태그"));
    expect(xml).toContain(`?tag=${encodeURIComponent("풍부태그")}</loc>`);
  });

  it("뉴스 사이트맵에도 얇은 기사는 빠진다", async () => {
    const now = new Date().toISOString();
    insertArticle({ slug: "fresh-thin", publishedAt: now, sources: one });
    insertArticle({ slug: "fresh-rich", publishedAt: now, sources: two });
    const xml = await (await app.request("/sitemap-news.xml")).text();
    expect(xml).toContain("/s/fresh-rich<");
    expect(xml).not.toContain("/s/fresh-thin<");
  });

  it("홈과 피드 목록·RSS는 얇은 기사도 그대로 보여준다", async () => {
    expect(await (await app.request("/")).text()).toContain("thin-one");
    expect(await (await app.request("/rss.xml")).text()).toContain("thin-one");
    expect(await (await app.request("/")).text()).not.toMatch(NOINDEX);
  });
});
