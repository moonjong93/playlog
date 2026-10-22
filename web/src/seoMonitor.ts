import { query, queryOne, run } from "./db.ts";
import {
  INDEXABLE_SQL,
  MIN_BODY_CHARS,
  MIN_SOURCES,
  MIN_TAG_ARTICLES,
  SOURCE_COUNT_SQL,
} from "./indexing.ts";

/**
 * 색인 준비 상태 집계.
 *
 * Search Console 수치(노출·클릭·색인된 페이지)는 API 인증 없이는 가져올 수 없으므로,
 * 여기서는 이쪽에서 통제 가능한 값(색인 대상 수·얇은 글 비율·발행 속도·사이트맵
 * 규모)만 본다. 이 값들이 구글 판정에 앞서 움직이는 선행 지표다.
 */

/** 사이트맵에 항상 들어가는 고정 URL: 홈, /tags, /deals, /about, /privacy, /terms, /contact. */
export const SITEMAP_STATIC_URLS = 7;

export type SeoStats = {
  generatedAt: string;
  articles: {
    total: number;
    indexable: number;
    excluded: number;
    /** 본문이 MIN_BODY_CHARS 미만. */
    thin: number;
    /** 출처가 MIN_SOURCES 미만. */
    fewSources: number;
    body: { under500: number; from500to899: number; from900: number };
    recent: { last24h: number; last7d: number; perDay7d: number };
  };
  tags: { total: number; indexable: number; excluded: number };
  sitemap: { articles: number; tags: number; fixed: number; total: number };
  thresholds: { minSources: number; minBodyChars: number; minTagArticles: number };
};

export type SeoCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "bad";
  detail: string;
  hint: string;
};

export type SeoReport = {
  stats: SeoStats;
  checks: SeoCheck[];
  verdict: "ok" | "warn" | "bad";
};

type CountsRow = {
  total: number;
  indexable: number;
  thin: number;
  few_sources: number;
  body_under_500: number;
  body_500_899: number;
  body_900: number;
  last24h: number;
  last7d: number;
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export function collectSeoStats(): SeoStats {
  const row =
    queryOne<CountsRow>(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN ${INDEXABLE_SQL} THEN 1 ELSE 0 END), 0) AS indexable,
        COALESCE(SUM(CASE WHEN length(articles.search_text) < ${MIN_BODY_CHARS}
          THEN 1 ELSE 0 END), 0) AS thin,
        COALESCE(SUM(CASE WHEN ${SOURCE_COUNT_SQL} < ${MIN_SOURCES}
          THEN 1 ELSE 0 END), 0) AS few_sources,
        COALESCE(SUM(CASE WHEN length(articles.search_text) < 500
          THEN 1 ELSE 0 END), 0) AS body_under_500,
        COALESCE(SUM(CASE WHEN length(articles.search_text) >= 500
          AND length(articles.search_text) < 900 THEN 1 ELSE 0 END), 0) AS body_500_899,
        COALESCE(SUM(CASE WHEN length(articles.search_text) >= 900
          THEN 1 ELSE 0 END), 0) AS body_900,
        COALESCE(SUM(CASE WHEN datetime(articles.published_at) >= datetime('now','-1 day')
          THEN 1 ELSE 0 END), 0) AS last24h,
        COALESCE(SUM(CASE WHEN datetime(articles.published_at) >= datetime('now','-7 day')
          THEN 1 ELSE 0 END), 0) AS last7d
      FROM articles
    `) ?? undefined;

  const total = num(row?.total);
  const indexable = num(row?.indexable);
  const tagTotal =
    queryOne<{ n: number }>("SELECT COUNT(DISTINCT tag) AS n FROM article_tags")?.n ?? 0;
  const tagIndexable =
    queryOne<{ n: number }>(`
      SELECT COUNT(*) AS n FROM (
        SELECT t.tag FROM article_tags t
        JOIN articles ON articles.slug = t.slug
        WHERE ${INDEXABLE_SQL}
        GROUP BY t.tag HAVING COUNT(*) >= ${MIN_TAG_ARTICLES}
      )
    `)?.n ?? 0;
  const last7d = num(row?.last7d);

  return {
    generatedAt: new Date().toISOString(),
    articles: {
      total,
      indexable,
      excluded: Math.max(0, total - indexable),
      thin: num(row?.thin),
      fewSources: num(row?.few_sources),
      body: {
        under500: num(row?.body_under_500),
        from500to899: num(row?.body_500_899),
        from900: num(row?.body_900),
      },
      recent: {
        last24h: num(row?.last24h),
        last7d,
        perDay7d: Math.round((last7d / 7) * 10) / 10,
      },
    },
    tags: {
      total: tagTotal,
      indexable: tagIndexable,
      excluded: Math.max(0, tagTotal - tagIndexable),
    },
    sitemap: {
      articles: indexable,
      tags: tagIndexable,
      fixed: SITEMAP_STATIC_URLS,
      total: indexable + tagIndexable + SITEMAP_STATIC_URLS,
    },
    thresholds: {
      minSources: MIN_SOURCES,
      minBodyChars: MIN_BODY_CHARS,
      minTagArticles: MIN_TAG_ARTICLES,
    },
  };
}

/** 현재 값으로 판정한다. 구글 판정을 대신하지 않고, 준비 상태만 본다. */
export function evaluateSeo(stats: SeoStats): SeoReport {
  const a = stats.articles;
  const checks: SeoCheck[] = [];

  checks.push(
    a.indexable === 0
      ? {
        id: "indexable",
        label: "색인 대상 기사",
        status: "bad",
        detail: "0편 — 기준을 통과한 기사가 없어 사이트맵에 기사가 없다.",
        hint: "기준을 낮추거나 본문·출처를 보강해야 한다.",
      }
      : a.indexable < 50
        ? {
          id: "indexable",
          label: "색인 대상 기사",
          status: "warn",
          detail: `${a.indexable}편 — 구글에 제출할 기사가 적다.`,
          hint: "발행 품질을 올려 색인 대상 수를 늘린다.",
        }
        : {
          id: "indexable",
          label: "색인 대상 기사",
          status: "ok",
          detail: `${a.indexable}편 (전체 ${a.total}편의 ${pct(a.indexable, a.total)}%)`,
          hint: "기준을 통과한 기사만 사이트맵에 나간다.",
        },
  );

  const thinRatio = pct(a.body.under500, a.total);
  checks.push({
    id: "body-depth",
    label: "본문 500자 미만 비율",
    status: thinRatio > 60 ? "bad" : thinRatio > 30 ? "warn" : "ok",
    detail: `${thinRatio}% (${a.body.under500}편 / 전체 ${a.total}편)`,
    hint: "Google 은 얇은 글을 사이트 단위로 평가한다. 30% 아래를 유지한다.",
  });

  const fewRatio = pct(a.fewSources, a.total);
  checks.push({
    id: "sources",
    label: `출처 ${MIN_SOURCES}개 미만 비율`,
    status: fewRatio > 60 ? "bad" : fewRatio > 40 ? "warn" : "ok",
    detail: `${fewRatio}% (${a.fewSources}편)`,
    hint: "여러 매체가 다룬 사건일수록 원문 대비 고유 가치가 생긴다.",
  });

  checks.push({
    id: "volume",
    label: "발행 속도 (최근 7일 하루 평균)",
    status: a.recent.perDay7d > 50 ? "bad" : a.recent.perDay7d > 20 ? "warn" : "ok",
    detail: `${a.recent.perDay7d}편/일 · 최근 24시간 ${a.recent.last24h}편`,
    hint: "신뢰가 낮은 도메인에서 하루 수십 편은 대량 생성 신호로 읽힌다.",
  });

  checks.push({
    id: "sitemap",
    label: "사이트맵 URL",
    status: stats.sitemap.total > 800 ? "bad" : stats.sitemap.total > 500 ? "warn" : "ok",
    detail: `${stats.sitemap.total}개 (기사 ${stats.sitemap.articles} · 태그 ${stats.sitemap.tags} · 고정 ${stats.sitemap.fixed})`,
    hint: "크롤링 예산이 없는 도메인은 300~500개 규모가 적당하다.",
  });

  checks.push({
    id: "tags",
    label: "색인되는 태그 페이지",
    status: stats.tags.indexable > 50 ? "warn" : "ok",
    detail: `${stats.tags.indexable}개 (전체 태그 ${stats.tags.total}개 중)`,
    hint: "태그 목록은 고유 콘텐츠가 아니므로 조건을 넘는 소수만 색인한다.",
  });

  const verdict = checks.some((check) => check.status === "bad")
    ? "bad"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";

  return { stats, checks, verdict };
}

export function seoReport(): SeoReport {
  return evaluateSeo(collectSeoStats());
}

export type SeoSnapshot = {
  taken_at: string;
  total_articles: number;
  indexable_articles: number;
  thin_articles: number;
  single_source_articles: number;
  indexable_tags: number;
  sitemap_urls: number;
};

/** 지금 값을 한 줄 남긴다. minIntervalHours 안에 이미 찍었으면 아무것도 하지 않는다. */
export function recordSeoSnapshot(stats: SeoStats, minIntervalHours = 6): boolean {
  const last = queryOne<{ taken_at: string }>(
    "SELECT taken_at FROM seo_snapshots ORDER BY taken_at DESC LIMIT 1",
  );
  if (last) {
    const ageHours = (Date.now() - Date.parse(last.taken_at)) / 3_600_000;
    if (Number.isFinite(ageHours) && ageHours < minIntervalHours) return false;
  }
  run(
    `INSERT OR REPLACE INTO seo_snapshots (
      taken_at, total_articles, indexable_articles, thin_articles,
      single_source_articles, indexable_tags, sitemap_urls
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      stats.generatedAt,
      stats.articles.total,
      stats.articles.indexable,
      stats.articles.thin,
      stats.articles.fewSources,
      stats.tags.indexable,
      stats.sitemap.total,
    ],
  );
  return true;
}

export function seoHistory(limit = 20): SeoSnapshot[] {
  return query<SeoSnapshot>(
    "SELECT * FROM seo_snapshots ORDER BY taken_at DESC LIMIT ?",
    [limit],
  );
}
