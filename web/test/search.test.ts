import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

beforeAll(() => {
  insertArticle({
    slug: "title-hit",
    title: "TGS 2026 특별 시연",
    body: "<p>제목에만 매치가 있다.</p>",
    section: "announce",
  });
  insertArticle({
    slug: "lede-hit",
    title: "요약 매치 기사",
    lede: "TGS 현장 요약 한 줄.",
    body: "<p>요약에 매치가 있다.</p>",
    section: "ship",
  });
  insertArticle({
    slug: "body-hit",
    title: "본문 매치 기사",
    body: "<p>본문에만 TGS 이야기가 들어 있다.</p>",
    section: "talk",
  });
  insertArticle({
    slug: "escape-hit",
    title: "특수문자 기사",
    body: "<p>a&lt;b&amp;c 를 비교한다.</p>",
  });
});

afterAll(() => cleanup());

describe("GET /search", () => {
  it("제목 > 리드 > 본문 순으로 정렬한다", async () => {
    const html = await (await app.request("/search?q=TGS")).text();
    const title = html.indexOf("2026 특별 시연");
    const lede = html.indexOf("요약 매치 기사");
    const body = html.indexOf("본문 매치 기사");
    expect(title).toBeGreaterThan(-1);
    expect(lede).toBeGreaterThan(title);
    expect(body).toBeGreaterThan(lede);
  });

  it("매치 부분을 mark로 표시한다", async () => {
    const html = await (await app.request("/search?q=TGS")).text();
    expect(html).toContain("<mark>TGS</mark>");
    expect(html).toContain("3건");
  });

  it("결과가 없으면 안내를 준다", async () => {
    const html = await (await app.request("/search?q=존재하지않는검색어")).text();
    expect(html).toContain("검색 결과가 없습니다");
  });

  it("1자 검색은 거부한다", async () => {
    const res = await app.request("/search?q=T");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("2자 이상 입력해 주세요");
    expect(html).not.toContain('class="feed-card');
  });

  it("빈 쿼리는 검색어 입력을 안내한다", async () => {
    const html = await (await app.request("/search")).text();
    expect(html).toContain("검색어를 입력하세요");
  });

  it("HX-Request-Type: partial이면 파셜만 돌려준다", async () => {
    const partial = await app.request("/search?q=TGS", {
      headers: { "HX-Request-Type": "partial" },
    });
    const partialHtml = await partial.text();
    expect(partialHtml).not.toContain("<!DOCTYPE html>");
    expect(partialHtml).not.toContain("<html");
    expect(partialHtml).toContain("2026 특별 시연");
    expect(partialHtml).toContain("<mark>TGS</mark>");

    const full = await app.request("/search?q=TGS", {
      headers: { "HX-Request-Type": "full" },
    });
    expect(await full.text()).toContain("<!DOCTYPE html>");
  });

  it("검색 폼은 JS 없이도 동작하고 htmx 속성을 갖는다", async () => {
    const html = await (await app.request("/search?q=TGS")).text();
    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('hx-action="/search"');
    expect(html).toContain('hx-target="#search-results"');
    expect(html).toContain('hx-trigger="input changed delay:300ms"');
    expect(html).toContain('id="search-results"');
    // 다른 페이지에서는 htmx 속성을 붙이지 않는다(#search-results가 없다).
    const feed = await (await app.request("/")).text();
    expect(feed).not.toContain("hx-trigger=");
  });

  it("검색 결과도 섹션 필터를 따른다", async () => {
    const html = await (await app.request("/search?q=TGS&section=ship")).text();
    expect(html).toContain("요약 매치 기사");
    expect(html).not.toContain("TGS 2026 특별 시연");
  });

  it("escape 후 mark만 삽입한다", async () => {
    const html = await (await app.request("/search?q=" + encodeURIComponent("a<b"))).text();
    expect(html).toContain("<mark>a&lt;b</mark>");
    expect(html).not.toContain("<mark>a<b</mark>");
  });

  it("LIKE 와일드카드는 문자로 취급한다", async () => {
    const html = await (await app.request("/search?q=" + encodeURIComponent("%%"))).text();
    expect(html).toContain("검색 결과가 없습니다");
  });
});
