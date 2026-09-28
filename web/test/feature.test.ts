import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

beforeAll(() => {
  insertArticle({
    slug: "feature-pubg",
    title: "한 번의 방플이 대회를 멈췄다",
    tags: ["특집", "PUBG"],
    publishedAt: "2026-09-28T09:00:00+09:00",
  });
  insertArticle({
    slug: "plain-news",
    title: "일반 기사",
    tags: ["PS5"],
    publishedAt: "2026-09-27T09:00:00+09:00",
  });
});

afterAll(() => cleanup());

/** 기사 본문 영역만 잘라낸다(헤더 네비의 #특집 링크와 구분하기 위해). */
function articleBody(html: string): string {
  const start = html.indexOf("<article>");
  const end = html.indexOf("</article>", start);
  return start === -1 ? "" : html.slice(start, end);
}

describe("특집 배지", () => {
  it("기사 상단에 배지를 그리고 태그 칩에서는 숨긴다", async () => {
    const html = await (await app.request("/s/feature-pubg")).text();
    const body = articleBody(html);
    expect(body).toContain("특집</span");
    expect(body).toContain("border-tertiary/40");
    expect(body).not.toContain("#특집");
    expect(body).toContain("#PUBG");
  });

  it("일반 기사에는 배지가 없다", async () => {
    const html = await (await app.request("/s/plain-news")).text();
    expect(articleBody(html)).not.toContain("border-tertiary/40");
  });

  it("피드 카드에도 배지가 붙는다", async () => {
    const html = await (await app.request("/")).text();
    // 첫 조각은 <head>(JSON-LD에 제목이 들어간다)라 버린다.
    const cards = html.split('class="feed-card').slice(1);
    const feature = cards.find((card) => card.includes("한 번의 방플이 대회를 멈췄다")) ?? "";
    const plain = cards.find((card) => card.includes("일반 기사")) ?? "";
    expect(feature).toContain("border-tertiary/40");
    expect(plain).not.toContain("border-tertiary/40");
  });

  it("특집 태그 필터로 모을 수 있다", async () => {
    const html = await (await app.request(`/?tag=${encodeURIComponent("특집")}`)).text();
    expect(html).toContain("한 번의 방플이 대회를 멈췄다");
    expect(html).not.toContain("일반 기사");
  });
});
