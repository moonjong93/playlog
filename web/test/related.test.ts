import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, cleanup, insertArticle } from "./helpers.ts";

afterAll(() => cleanup());

/** 기사 하단 "관련 기사" 블록만 잘라낸다(바로 앞 출처 aside 다음 ~ 닫는 aside). */
function relatedSlugs(html: string): string[] {
  const start = html.indexOf("관련 기사");
  if (start === -1) return [];
  const end = html.indexOf("</aside>", start);
  const section = html.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/href="\/s\/([^"]+)"/g)].map((match) =>
    decodeURIComponent(match[1])
  );
}

beforeAll(() => {
  insertArticle({
    slug: "focus",
    title: "기준 기사",
    tags: ["RPG", "닌텐도"],
    publishedAt: "2026-09-19T10:00:00+09:00",
  });
  insertArticle({
    slug: "two-shared",
    title: "태그 두 개 공유",
    tags: ["RPG", "닌텐도"],
    publishedAt: "2026-09-19T09:00:00+09:00",
  });
  insertArticle({
    slug: "one-shared-new",
    title: "태그 하나 공유(최신)",
    tags: ["RPG"],
    publishedAt: "2026-09-19T08:00:00+09:00",
  });
  insertArticle({
    slug: "one-shared-old",
    title: "태그 하나 공유(오래됨)",
    tags: ["RPG"],
    publishedAt: "2026-09-18T08:00:00+09:00",
  });
  for (const [slug, hour] of [["filler-1", 11], ["filler-2", 12], ["filler-3", 13]] as const) {
    insertArticle({
      slug,
      title: `태그 안 겹치는 기사 ${hour}`,
      tags: ["스포츠"],
      publishedAt: `2026-09-19T${hour}:00:00+09:00`,
    });
  }
  insertArticle({
    slug: "untagged",
    title: "태그 없는 기사",
    publishedAt: "2026-09-19T14:00:00+09:00",
  });
});

describe("관련 기사", () => {
  it("같은 태그를 많이 공유하는 순, 동점이면 최신순으로 5개를 붙인다", async () => {
    const html = await (await app.request("/s/focus")).text();
    expect(relatedSlugs(html)).toEqual([
      "two-shared",
      "one-shared-new",
      "one-shared-old",
      "untagged",
      "filler-3",
    ]);
  });

  it("자기 자신은 넣지 않는다", async () => {
    const html = await (await app.request("/s/focus")).text();
    expect(relatedSlugs(html)).not.toContain("focus");
  });

  it("태그가 없으면 최신 기사로 채운다", async () => {
    const html = await (await app.request("/s/untagged")).text();
    expect(relatedSlugs(html)).toEqual([
      "filler-3",
      "filler-2",
      "filler-1",
      "focus",
      "two-shared",
    ]);
  });
});
