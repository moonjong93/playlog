import { queryOne } from "./db.ts";

/**
 * 검색엔진 색인 대상 기준.
 *
 * 2026-10-22 실측 기준선: 30일 동안 2,683편이 쌓였고 그중 68%(1,829편)가 본문
 * 500자 미만, 76%(2,037편)가 출처 1개였다. 이 상태로 1,235편을 사이트맵에 넣었더니
 * Search Console 은 "색인 생성됨 0 / 발견됨·색인 안 됨 399"로 응답했고,
 * Googlebot 은 2026-10-15 에 홈을 크롤링한 뒤 색인을 거부했다(가져오기·색인
 * 허용은 모두 정상). 신뢰가 0인 도메인에서 얇은 글을 대량 노출하면 사이트 전체가
 * 낮게 평가되므로 노출 면적을 줄이고 남은 페이지의 밀도를 올린다.
 *
 * 기준 밖 페이지는 사용자에게는 그대로 열리되 noindex + 사이트맵 제외다.
 * 기준을 바꾸면 /internal/seo 대시보드에서 즉시 영향 수를 확인할 수 있다.
 */

/** 출처가 이만큼 이상이면(여러 매체가 다룬 사건) 색인 대상. */
export const MIN_SOURCES = 3;
/** 본문(텍스트)이 이 글자 수 이상이면 색인 대상. */
export const MIN_BODY_CHARS = 900;
/** 색인 대상 기사가 이만큼 이상 있는 태그만 태그 페이지를 색인한다. */
export const MIN_TAG_ARTICLES = 8;

/** articles 행이 색인 대상인지(출처 수 또는 본문 길이). articles 테이블 컬럼을 직접 쓴다. */
export const INDEXABLE_SQL = `(
  (CASE WHEN json_valid(articles.sources_json)
        THEN json_array_length(articles.sources_json) ELSE 0 END) >= ${MIN_SOURCES}
  OR length(articles.search_text) >= ${MIN_BODY_CHARS}
)`;

/** 출처 개수만 보는 식. 대시보드의 분포 계산에 쓴다. */
export const SOURCE_COUNT_SQL = `(CASE WHEN json_valid(articles.sources_json)
  THEN json_array_length(articles.sources_json) ELSE 0 END)`;

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
