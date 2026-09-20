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
    section: "announce",
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
    section: "ship",
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

  it("기사 상세에 출처/커뮤니티 인용/요약 박스가 그대로 나온다", async () => {
    const html = await (await app.request("/s/tgs-2026-report")).text();
    expect(html).toContain("커뮤니티 반응");
    expect(html).toContain("u/neogaf_user");
    expect(html).toContain("출처");
    expect(html).toContain("summary-box");
    expect(html).toContain("Famitsu");
    expect(html).toContain('lang="ko"');
  });

  it("목록 카드에 출처 배지가 다시 보인다", async () => {
    const html = await (await app.request("/")).text();
    expect(html).toContain("feed-card");
    expect(html).toContain("Famitsu");
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
    expect(xml).toContain("<rss version=\"2.0\">");
    expect(xml).toContain("<item>");
    expect(xml).toContain("TGS 2026 현장 리포트");
    expect(xml).toContain("<guid");
  });

  it("sitemap.xml은 전체 slug와 발행일을 담는다", async () => {
    const res = await app.request("/sitemap.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain("<loc>/s/tgs-2026-report</loc>");
    expect(xml).toContain("<loc>/s/indie-ship</loc>");
    expect(xml).toContain("<lastmod>");
  });

  it("robots.txt는 sitemap을 안내한다", async () => {
    const res = await app.request("/robots.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("User-agent: *");
    expect(text).toContain("Disallow: /internal/");
  });

  it.skipIf(!hasHtmxAsset)("htmx 정적 파일을 로컬에서 서빙한다", async () => {
    const res = await app.request("/assets/htmx.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("htmx");
  });
});
