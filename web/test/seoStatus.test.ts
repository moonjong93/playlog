import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, app, cleanup, insertArticle } from "./helpers.ts";

const SEO_TOKEN = process.env.SEO_DASH_TOKEN as string;
const src = (name: string) => ({
  name,
  url: `https://example.com/${name.toLowerCase()}`,
  role: "primary",
});
const three = [src("A"), src("B"), src("C")];
const one = [src("A")];
const NOINDEX = /<meta name="robots" content="noindex, follow"/;

function get(path: string, key = API_KEY): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${key}` } });
}

beforeAll(() => {
  insertArticle({ slug: "seo-rich", tags: ["관측태그"], sources: three });
  insertArticle({ slug: "seo-thin", tags: ["관측태그"], sources: one });
});
afterAll(() => cleanup());

describe("/internal/seo 관측 대시보드", () => {
  it("인증 없이는 401", async () => {
    expect((await app.request("/internal/seo")).status).toBe(401);
    expect((await app.request("/internal/seo.json")).status).toBe(401);
  });

  it("Bearer 키로 HTML 대시보드를 연다", async () => {
    const res = await get("/internal/seo");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("SEO 관측");
    expect(html).toContain("색인 대상");
    expect(html).toMatch(NOINDEX);
  });

  it("SEO_DASH_TOKEN 쿼리로도 열린다", async () => {
    const res = await app.request(`/internal/seo.json?token=${SEO_TOKEN}`);
    expect(res.status).toBe(200);
    expect((await app.request("/internal/seo.json?token=wrong")).status).toBe(401);
  });

  it("JSON은 통계·점검·판정을 담는다", async () => {
    const body = await (await get("/internal/seo.json")).json() as {
      stats: {
        articles: { total: number; indexable: number; thin: number };
        tags: { indexable: number };
        sitemap: { articles: number; total: number };
        thresholds: { minSources: number; minBodyChars: number; minTagArticles: number };
      };
      checks: { id: string; status: string }[];
      verdict: string;
      history: unknown[];
    };
    expect(body.stats.articles.total).toBeGreaterThanOrEqual(2);
    expect(body.stats.articles.indexable).toBeGreaterThanOrEqual(1);
    expect(body.stats.thresholds).toEqual({
      minSources: 3,
      minBodyChars: 900,
      minTagArticles: 8,
    });
    // 사이트맵 합계는 기사 + 태그 + 고정 URL 이다.
    expect(body.stats.sitemap.total).toBe(
      body.stats.sitemap.articles + body.stats.tags.indexable + 7,
    );
    const ids = body.checks.map((check) => check.id);
    expect(ids).toEqual(
      expect.arrayContaining(["indexable", "body-depth", "sources", "volume", "sitemap", "tags"]),
    );
    expect(["ok", "warn", "bad"]).toContain(body.verdict);
    expect(Array.isArray(body.history)).toBe(true);
  });

  it("스냅샷은 6시간에 한 번만 쌓인다", async () => {
    const first = await (await get("/internal/seo.json")).json() as { snapshotRecorded: boolean };
    const second = await (await get("/internal/seo.json")).json() as { snapshotRecorded: boolean };
    // 첫 호출과 직전 테스트에서 이미 찍혔을 수 있으므로 두 번째는 반드시 false.
    expect(second.snapshotRecorded).toBe(false);
    expect(typeof first.snapshotRecorded).toBe("boolean");
  });

  it("색인 대상 수와 사이트맵 URL 수가 대시보드에 반영된다", async () => {
    const body = await (await get("/internal/seo.json")).json() as {
      stats: { articles: { indexable: number }; sitemap: { total: number } };
    };
    const xml = await (await app.request("/sitemap.xml")).text();
    const locs = (xml.match(/<loc>/g) ?? []).length;
    expect(locs).toBe(body.stats.sitemap.total);
    expect(body.stats.sitemap.total).toBeGreaterThan(body.stats.articles.indexable);
  });
});
