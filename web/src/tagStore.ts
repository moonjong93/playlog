import { query, queryOne, run } from "./db.ts";
import { MAX_TAGS, TAGS_PAGE_SIZE } from "./tags.ts";

export type TagStat = {
  tag: string;
  count: number;
  last_published_at: string;
};

/** 슬러그 여러 개의 태그를 한 번에 읽는다(N+1 방지). */
export function tagsFor(slugs: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (slugs.length === 0) return map;
  const placeholders = slugs.map(() => "?").join(", ");
  const rows = query<{ slug: string; tag: string }>(
    `SELECT slug, tag FROM article_tags WHERE slug IN (${placeholders}) ORDER BY tag`,
    slugs,
  );
  for (const row of rows) {
    const tags = map.get(row.slug);
    if (tags) tags.push(row.tag);
    else map.set(row.slug, [row.tag]);
  }
  return map;
}

/** 기사 하나의 태그를 통째로 교체한다. 트랜잭션은 호출부에서 연다. */
export function replaceTags(slug: string, tags: string[]): void {
  run("DELETE FROM article_tags WHERE slug = ?", [slug]);
  for (const tag of tags) {
    run("INSERT OR IGNORE INTO article_tags (slug, tag) VALUES (?, ?)", [slug, tag]);
  }
}

/** 최근 발행 기사에 붙은 태그순(MAX(published_at) DESC) 상위 limit개. */
export function recentTags(limit = MAX_TAGS): string[] {
  return query<{ tag: string }>(
    `SELECT t.tag AS tag, MAX(a.published_at) AS last_published_at
     FROM article_tags t
     JOIN articles a ON a.slug = t.slug
     GROUP BY t.tag
     ORDER BY last_published_at DESC, t.tag ASC
     LIMIT ?`,
    [limit],
  ).map((row) => row.tag);
}

/** 사용 횟수순 전체 태그. 페이지당 TAGS_PAGE_SIZE개. */
export function allTags(page: number): TagStat[] {
  const offset = Math.max(0, page - 1) * TAGS_PAGE_SIZE;
  return query<TagStat>(
    `SELECT t.tag AS tag, COUNT(*) AS count, MAX(a.published_at) AS last_published_at
     FROM article_tags t
     JOIN articles a ON a.slug = t.slug
     GROUP BY t.tag
     ORDER BY count DESC, last_published_at DESC, t.tag ASC
     LIMIT ? OFFSET ?`,
    [TAGS_PAGE_SIZE, offset],
  );
}

export function tagTotal(): number {
  return (
    queryOne<{ n: number }>("SELECT COUNT(DISTINCT tag) AS n FROM article_tags")?.n ?? 0
  );
}
