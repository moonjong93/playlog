import { queryOne } from "./db.ts";

/**
 * 검색엔진 색인 대상 기준. 새 도메인에 얇은 글이 대량으로 쌓이면 Google 이
 * "크롤링됨 - 색인 안 됨"으로 사이트 전체를 낮게 보므로, 가치 있는 페이지만 연다.
 * 기준 밖 페이지는 사용자에게는 그대로 열리되 noindex + 사이트맵 제외다.
 */

/** 출처가 이만큼 이상이면(여러 매체가 다룬 사건) 색인 대상. */
export const MIN_SOURCES = 2;
/** 본문(텍스트)이 이 글자 수 이상이면 색인 대상. */
export const MIN_BODY_CHARS = 500;
/** 색인 대상 기사가 이만큼 이상 있는 태그만 태그 페이지를 색인한다. */
export const MIN_TAG_ARTICLES = 3;

/** articles 행이 색인 대상인지(출처 수 또는 본문 길이). articles 테이블 컬럼을 직접 쓴다. */
export const INDEXABLE_SQL = `(
  (CASE WHEN json_valid(articles.sources_json)
        THEN json_array_length(articles.sources_json) ELSE 0 END) >= ${MIN_SOURCES}
  OR length(articles.search_text) >= ${MIN_BODY_CHARS}
)`;

export function isArticleIndexable(slug: string): boolean {
  return (
    queryOne<{ ok: number }>(
      `SELECT ${INDEXABLE_SQL} AS ok FROM articles WHERE slug = ?`,
      [slug],
    )?.ok === 1
  );
}

export function isTagIndexable(tag: string): boolean {
  const n =
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM article_tags t
       JOIN articles ON articles.slug = t.slug
       WHERE t.tag = ? AND ${INDEXABLE_SQL}`,
      [tag],
    )?.n ?? 0;
  return n >= MIN_TAG_ARTICLES;
}
