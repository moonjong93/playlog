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
  /** info = 설계 선택이라 조치 대상이 아님(판정에 반영하지 않는다). */
  status: "ok" | "warn" | "bad" | "info";
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
    label: "짧은 브리핑 비율 (본문 500자 미만)",
    // 짧은 브리핑은 이 서비스의 설계다. 길이가 아니라 노출 규모가 조치 대상이므로
    // 참고값으로만 두고 판정에는 넣지 않는다.
    status: "info",
    detail: `${thinRatio}% (${a.body.under500}편 / 전체 ${a.total}편)`,
    hint: "설계상 짧은 요약이라 조치 대상이 아니다. 짧아도 색인은 된다.",
  });

  const fewRatio = pct(a.fewSources, a.total);
  checks.push({
    id: "sources",
    label: `단일 출처 기사 비율 (출처 ${MIN_SOURCES}개 미만)`,
    status: "info",
    detail: `${fewRatio}% (${a.fewSources}편)`,
    hint: "여러 매체가 다룬 사건일수록 원문 대비 고유 가치가 커진다. 참고값.",
  });

  checks.push({
    id: "volume",
    label: "발행 속도 (최근 7일 하루 평균)",
    status: a.recent.perDay7d > 50 ? "bad" : a.recent.perDay7d > 20 ? "warn" : "ok",
    detail: `${a.recent.perDay7d}편/일 · 최근 24시간 ${a.recent.last24h}편`,
    hint: "막 생긴 도메인이 하루 수십 편을 쏟으면 '대량 생성'으로 읽힌다. 20편 아래 유지.",
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

/**
 * 관찰 계획.
 *
 * 신뢰가 0인 도메인은 지표를 고쳐서 색인을 앞당길 수 없다. 대신 "언제까지
 * 무엇을 보면 판단이 서는지"를 정해 두고, 그 시점에 다음 수를 결정한다.
 */
export const SEO_BASELINE = "2026-10-22";

export type SeoCheckpoint = {
  /** 기준일로부터 지난 일수. */
  day: number;
  date: string;
  /** 이 시점에 볼 것. */
  watch: string;
  /** 기대선. */
  target: string;
  /** 못 넘었을 때 할 일. */
  fallback: string;
  reached: boolean;
};

const CHECKPOINT_PLANS = [
  {
    day: 14,
    watch: "Search Console → 페이지 → 색인 생성됨",
    target: "1개 이상이면 정상 궤도(첫 색인이 가장 어렵다)",
    fallback: "0개면 게임 커뮤니티에 링크 1~2개를 직접 만든다",
  },
  {
    day: 30,
    watch: "색인 생성됨 수 / 발견됨·색인 안 됨 추이",
    target: "색인 10개 이상, 발견됨이 300 아래로 감소",
    fallback: "0~2개면 대기만으로는 안 된다 → 링크·브랜드가 필수",
  },
  {
    day: 60,
    watch: "색인 생성됨 수",
    target: "색인 50개 이상이면 게이트를 풀어 노출을 넓힌다",
    fallback: "< 10개면 콘텐츠 신뢰 구조(원본성·운영 주체)를 다시 설계",
  },
];

export function seoCheckpoints(today = new Date()): SeoCheckpoint[] {
  const base = new Date(`${SEO_BASELINE}T00:00:00Z`).getTime();
  return CHECKPOINT_PLANS.map((plan) => {
    const at = new Date(base + plan.day * 86_400_000);
    return {
      ...plan,
      date: at.toISOString().slice(0, 10),
      reached: today.getTime() >= at.getTime(),
    };
  });
}
