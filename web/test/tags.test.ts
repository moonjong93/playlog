import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeTags } from "../src/tags.ts";
import { app, cleanup, insertArticle } from "./helpers.ts";

afterAll(() => cleanup());

function cards(html: string): string[] {
  return html.match(/class="feed-card/g) ?? [];
}

function headerNav(html: string): string {
  const start = html.indexOf('aria-label="태그"');
  const end = html.indexOf("</nav>", start);
  return html.slice(start, end);
}

describe("normalizeTags", () => {
  it("문자열은 쉼표/슬래시로 나눈다", () => {
    expect(normalizeTags("닌텐도, 스위치/젤다")).toEqual(["닌텐도", "스위치", "젤다"]);
  });

  it("배열이 아니면 빈 배열", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(42)).toEqual([]);
    expect(normalizeTags({ tag: "닌텐도" })).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("선행 #과 허용 밖 문자를 제거한다", () => {
    expect(normalizeTags(["#닌텐도!", " TGS2026 ", "스위치(신형)"])).toEqual([
      "닌텐도",
      "TGS2026",
      "스위치신형",
    ]);
    // writer의 normalize_tags와 같은 규칙: 배열 항목의 슬래시도 지운다.
    expect(normalizeTags(["TGS/2026"])).toEqual(["TGS2026"]);
  });

  it("연속 공백은 1칸, 20자에서 자른다", () => {
    expect(normalizeTags(["닌텐도   스위치"])).toEqual(["닌텐도 스위치"]);
    expect(normalizeTags(["가".repeat(25)])[0].length).toBe(20);
  });

  it("2자 미만은 버린다", () => {
    expect(normalizeTags(["a", "가", "ab"])).toEqual(["ab"]);
  });

  it("대소문자 무시 중복은 먼저 표기를 남긴다", () => {
    expect(normalizeTags(["TGS", "tgs", "Tgs2026"])).toEqual(["TGS", "Tgs2026"]);
  });

  it("최대 5개", () => {
    expect(normalizeTags(["a1", "a2", "a3", "a4", "a5", "a6"])).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  });

  it("문자열이 아닌 원소는 건너뛴다", () => {
    expect(normalizeTags(["닌텐도", 5, null, "스위치"])).toEqual(["닌텐도", "스위치"]);
  });
});

describe("태그 피드/목록", () => {
  beforeAll(() => {
    insertArticle({
      slug: "nav-1",
      title: "태그 기사 1",
      tags: ["태그1"],
      publishedAt: "2026-09-19T03:00:00Z",
    });
    insertArticle({
      slug: "nav-2",
      title: "태그 기사 2",
      tags: ["태그2"],
      publishedAt: "2026-09-18T03:00:00Z",
    });
    insertArticle({
      slug: "nav-3",
      title: "태그 기사 3",
      tags: ["태그3"],
      publishedAt: "2026-09-17T03:00:00Z",
    });
    insertArticle({
      slug: "nav-4",
      title: "태그 기사 4",
      tags: ["태그4"],
      publishedAt: "2026-09-16T03:00:00Z",
    });
    insertArticle({
      slug: "nav-5",
      title: "태그 기사 5",
      tags: ["태그5"],
      publishedAt: "2026-09-15T03:00:00Z",
    });
    insertArticle({
      slug: "nav-6",
      title: "태그 기사 6",
      tags: ["태그6"],
      publishedAt: "2026-09-14T03:00:00Z",
    });
    insertArticle({
      slug: "shared-1",
      title: "공통 기사 1",
      tags: ["공통"],
      publishedAt: "2026-09-13T03:00:00Z",
    });
    insertArticle({
      slug: "shared-2",
      title: "공통 기사 2",
      tags: ["공통"],
      publishedAt: "2026-09-12T03:00:00Z",
    });
    insertArticle({
      slug: "bulk-1",
      title: "대량 태그 기사",
      tags: Array.from({ length: 30 }, (_, i) => `대량${String(i + 1).padStart(2, "0")}`),
      publishedAt: "2026-09-01T03:00:00Z",
    });
  });

  it("?tag= 필터는 해당 태그 기사만 보여준다", async () => {
    const html = await (
      await app.request(`/?tag=${encodeURIComponent("공통")}`)
    ).text();
    expect(cards(html).length).toBe(2);
    expect(html).toContain("공통 기사 1");
    expect(html).toContain("공통 기사 2");
    expect(html).not.toContain("태그 기사 1");
    expect(html).toContain("2건");
  });

  it("없는 태그면 빈 결과 안내", async () => {
    const html = await (
      await app.request(`/?tag=${encodeURIComponent("없는태그")}`)
    ).text();
    expect(cards(html).length).toBe(0);
    expect(html).toContain("태그의 기사가 없습니다");
    expect(html).toContain("0건");
  });

  it("?section= 은 더 이상 필터가 아니다", async () => {
    const all = await (await app.request("/")).text();
    const sectioned = await (await app.request("/?section=ship")).text();
    expect(cards(sectioned).length).toBe(cards(all).length);
    expect(cards(sectioned).length).toBe(9);
    expect(sectioned).toContain("9건");
  });

  it("피드 카드 칩은 /?tag= 로 링크한다", async () => {
    const html = await (
      await app.request(`/?tag=${encodeURIComponent("공통")}`)
    ).text();
    expect(html).toContain(`href="/?tag=${encodeURIComponent("공통")}"`);
  });

  it("네비는 최근 발행 태그 5개를 최신순으로 보여준다", async () => {
    const html = await (await app.request("/")).text();
    const nav = headerNav(html);
    const expected = ["태그1", "태그2", "태그3", "태그4", "태그5"];
    for (const tag of expected) {
      expect(nav).toContain(`#${tag}`);
    }
    expect(nav).not.toContain("#태그6");
    expect(nav).not.toContain("#공통");
    const positions = expected.map((tag) => nav.indexOf(`#${tag}`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(nav).toContain('href="/tags"');
    expect(nav).toContain("전체보기");
  });

  it("태그 필터 중에는 네비에서 활성 표시한다", async () => {
    const html = await (
      await app.request(`/?tag=${encodeURIComponent("태그1")}`)
    ).text();
    const nav = headerNav(html);
    const at = nav.indexOf("#태그1");
    const link = nav.slice(nav.lastIndexOf("<a ", at), at);
    expect(link).toContain("border-b-2 border-primary");
  });

  it("/tags는 사용 횟수순 30개 + 페이징", async () => {
    const page1 = await (await app.request("/tags")).text();
    expect((page1.match(/<li>/g) ?? []).length).toBe(30);
    expect(page1).toContain("37개");
    expect(page1).toContain("#공통");
    expect(page1).toContain("2건");
    expect(page1).toContain('href="/tags?page=2"');
    // 사용 횟수 2인 공통이 첫 행, 그 다음은 최근 발행순(태그1).
    const firstRowEnd = page1.indexOf("</li>");
    const firstRow = page1.slice(0, firstRowEnd);
    const secondRow = page1.slice(firstRowEnd, page1.indexOf("</li>", firstRowEnd + 1));
    expect(firstRow).toContain("#공통");
    expect(firstRow).toContain("2건");
    expect(secondRow).toContain("#태그1");

    const page2 = await (await app.request("/tags?page=2")).text();
    expect((page2.match(/<li>/g) ?? []).length).toBe(7);
    expect(page2).toContain('href="/tags"');
    expect(page2).toContain("이전");
  });

  it("/tags는 활성 태그 행을 표시한다", async () => {
    const html = await (
      await app.request(`/tags?tag=${encodeURIComponent("태그1")}`)
    ).text();
    expect(html).toContain("bg-surface-variant border border-primary/60");
  });
});
