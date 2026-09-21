import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

// npm run assets를 아직 안 돌렸으면 이 케이스만 건너뛴다.
const hasHtmxAsset = existsSync(join(import.meta.dirname, "../dist/htmx.min.js"));

beforeAll(() => {
  insertArticle({
    slug: "tgs-2026-report",
    title: "TGS 2026 현장 리포트",
    lede: "도쿄 게임쇼 첫날 풍경.",
    tags: ["발표·신작"],
    sources: [
      {
        name: "Famitsu",
        url: "https://example.com/famitsu",
        role: "primary",
        comments: [{ author: "neogaf_user", text: "부스가 정말 컸다" }],
      },
    ],
  });
  insertArticle({
    slug: "indie-ship",
    title: "인디 게임 정식 출시",
    body: "<p>오늘 정식 출시되었다.</p>",
    tags: ["출시·패치"],
  });
});

afterAll(() => cleanup());

describe("공개 읽기", () => {
  it("GET /health는 키 없이 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("목록/기사/검색이 키 없이 200", async () => {
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/s/tgs-2026-report")).status).toBe(200);
    expect((await app.request("/search?q=TGS")).status).toBe(200);
  });

  it("기사 상세에 출처/사용자 반응/요약 박스/태그 칩이 그대로 나온다", async () => {
    const html = await (await app.request("/s/tgs-2026-report")).text();
    expect(html).toContain("사용자 반응");
    expect(html).toContain("부스가 정말 컸다");
    expect(html).not.toContain("u/neogaf_user");
    expect(html).toContain("출처");
    expect(html).toContain("summary-box");
    expect(html).toContain("Famitsu");
    expect(html).toContain('lang="ko"');
    expect(html).toContain(`href="/?tag=${encodeURIComponent("발표·신작")}"`);
  });

  it("목록 카드에 출처 배지가 다시 보인다", async () => {
    const html = await (await app.request("/")).text();
    expect(html).toContain("feed-card");
    expect(html).toContain("Famitsu");
    expect(html).toContain(`href="/?tag=${encodeURIComponent("출시·패치")}"`);
  });

  it("?key= 쿼리는 인증 경로가 아니고 링크에도 남지 않는다", async () => {
    const res = await app.request("/?key=dev-key");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("key=dev-key");
    expect((await app.request("/search?q=TGS&key=dev-key")).status).toBe(200);
  });

  it("없는 경로/기사는 404", async () => {
    expect((await app.request("/그런거없음")).status).toBe(404);
    expect((await app.request("/s/없는슬러그")).status).toBe(404);
  });

  it("rss.xml은 최신 20건을 담는다", async () => {
    const res = await app.request("/rss.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await res.text();
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<item>");
    expect(xml).toContain("TGS 2026 현장 리포트");
    expect(xml).toContain("<guid isPermaLink=\"true\">http://localhost/s/tgs-2026-report</guid>");
    expect(xml).toContain("<category>발표·신작</category>");
    expect(xml).toContain('rel="self"');
  });

  it("sitemap.xml은 기사·태그·OG 이미지를 담는다", async () => {
    const res = await app.request("/sitemap.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain("<loc>http://localhost/s/tgs-2026-report</loc>");
    expect(xml).toContain("<loc>http://localhost/s/indie-ship</loc>");
    expect(xml).toContain("<lastmod>");
    expect(xml).toContain("<image:loc>http://localhost/og/s/tgs-2026-report.png</image:loc>");
    expect(xml).toContain("<loc>http://localhost/?tag=");
  });

  it("sitemap-news.xml은 최근 48시간 기사만 담는다", async () => {
    const now = new Date().toISOString();
    insertArticle({ slug: "fresh-news", title: "방금 나온 소식", publishedAt: now });
    insertArticle({
      slug: "stale-news",
      title: "오래된 소식",
      publishedAt: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(),
    });
    const res = await app.request("/sitemap-news.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("http://www.google.com/schemas/sitemap-news/0.9");
    expect(xml).toContain("<news:title>방금 나온 소식</news:title>");
    expect(xml).toContain("<news:language>ko</news:language>");
    expect(xml).not.toContain("stale-news");
  });

  it("robots.txt는 검색 봇 허용·AI 학습 차단·sitemap 안내를 담는다", async () => {
    const res = await app.request("/robots.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Content-Signal: ai-train=no, search=yes");
    expect(text).toContain("User-agent: GPTBot");
    expect(text).toContain("User-agent: *");
    expect(text).toContain("Disallow: /internal/");
    expect(text).toContain("Disallow: /search");
    expect(text).toContain("Sitemap: http://localhost/sitemap.xml");
    expect(text).toContain("Sitemap: http://localhost/sitemap-news.xml");
  });

  it("head·RSS·뉴스 사이트맵·JSON-LD가 PLAYLOG 브랜드를 쓴다", async () => {
    insertArticle({
      slug: "brand-fresh",
      title: "브랜드 확인용 기사",
      publishedAt: new Date().toISOString(),
    });

    const home = await (await app.request("/")).text();
    expect(home).toContain("<title>PLAYLOG ·");
    expect(home).toContain('property="og:site_name" content="PLAYLOG"');
    expect(home).toContain('"name":"PLAYLOG"');
    expect(home).toContain('clip-path="url(#mark)"'); // 헤더에 인라인 로고

    const rss = await (await app.request("/rss.xml")).text();
    expect(rss).toContain("<title>PLAYLOG ·");
    expect(rss).toContain("게임 뉴스 &amp; 스토리");

    const news = await (await app.request("/sitemap-news.xml")).text();
    expect(news).toContain("<news:name>PLAYLOG</news:name>");
  });

  it("favicon·앱 아이콘·매니페스트를 서빙한다", async () => {
    const svg = await app.request("/assets/favicon.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toContain("M212.688");

    const icon = await app.request("/assets/icon-192.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await icon.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const manifest = await app.request("/site.webmanifest");
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toContain('"name": "PLAYLOG"');
  });

  it("기사 OG 카드는 PNG로 나오고 없는 슬러그는 404", async () => {
    const res = await app.request("/og/s/tgs-2026-report.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    expect((await app.request("/og/s/없는-기사.png")).status).toBe(404);
    expect((await app.request("/og/default.png")).status).toBe(200);
    expect((await app.request("/og/nope")).status).toBe(404);
  });

  it.skipIf(!hasHtmxAsset)("htmx 정적 파일을 로컬에서 서빙한다", async () => {
    const res = await app.request("/assets/htmx.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("htmx");
  });
});
