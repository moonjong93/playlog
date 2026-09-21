import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { html } from "hono/html";
import { query, queryOne, run, transaction } from "./db.ts";
import { env, isRateLimitDisabled, rootDir } from "./env.ts";
import { clientIp, consume, hashIp } from "./ratelimit.ts";
import { ensureSession } from "./session.ts";
import { sanitizeBodyHtml, toSearchText } from "./sanitize.ts";
import { LEGACY_SECTION_TAGS, normalizeTags } from "./tags.ts";
import { allTags, replaceTags, tagTotal, tagsFor } from "./tagStore.ts";
import { PAGE_SIZE, feedPage } from "./pages/feed.ts";
import { tagsPage } from "./pages/tags.ts";
import { articlePage, type RelatedRow } from "./pages/article.ts";
import {
  QUERY_MAX,
  QUERY_MIN,
  type SearchHit,
  searchPage,
  searchResults,
} from "./pages/search.ts";
import {
  BODY_MAX,
  BODY_MIN,
  COMMENT_PAGE_SIZE,
  HONEYPOT_FIELD,
  NICKNAME_MAX,
  commentCount,
  commentEmptyClear,
  commentError,
  commentErrorClear,
  commentItem,
  commentTombstone,
  type CommentRow,
} from "./pages/comments.ts";
import {
  messagePage,
  noticeFragment,
  notFoundPage,
  pageNotFoundPage,
} from "./pages/misc.ts";
import { type ArticleRow } from "./pages/layout.ts";
import { logoPng, logoSvg, manifestJson } from "./brand.ts";
import { DEFAULT_OG_KEY, articleOgCard, defaultOgCard, ogPng } from "./og.ts";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "./site.ts";

type AppEnv = { Variables: { ip: string; sid: string } };

export const app = new Hono<AppEnv>();

const ARTICLE_COLUMNS = `slug, title_ko, lede_ko, body_html,
  published_at, updated_at, story_id, sources_json`;

const COMMENT_COLUMNS = "id, nickname, body, session_id, created_at";

function nowIso(): string {
  return new Date().toISOString();
}

function wantsPartial(c: Context): boolean {
  return c.req.header("HX-Request-Type") === "partial";
}

/** 절대 URL 기준. SITE_URL이 없으면 요청 origin을 쓴다(로컬 개발 포함). */
function originOf(c: Context): string {
  return env.siteUrl || new URL(c.req.url).origin;
}

/** 레이트 리밋을 적용하지 않는 정적·크롤러용 경로. */
function isCacheableAsset(path: string): boolean {
  return (
    path.startsWith("/assets/") ||
    path.startsWith("/og/") ||
    path === "/favicon.ico" ||
    path === "/robots.txt" ||
    path === "/site.webmanifest" ||
    path === "/sitemap.xml" ||
    path === "/sitemap-news.xml"
  );
}

function pngResponse(c: Context, png: Uint8Array, maxAge: number) {
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=604800`);
  return c.body(png as unknown as ArrayBuffer, 200);
}

function articleExists(slug: string): boolean {
  return queryOne<{ slug: string }>("SELECT slug FROM articles WHERE slug = ?", [slug]) !== undefined;
}

function commentsFor(slug: string): CommentRow[] {
  return query<CommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM comments
     WHERE slug = ? AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [slug, COMMENT_PAGE_SIZE],
  );
}

function commentTotal(slug: string): number {
  return (
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM comments WHERE slug = ? AND deleted_at IS NULL",
      [slug],
    )?.n ?? 0
  );
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** 조회한 기사들에 태그를 붙인다(쿼리 1회). */
function withTags<T extends { slug: string }>(rows: T[]): (T & { tags: string[] })[] {
  if (rows.length === 0) return [];
  const bySlug = tagsFor(rows.map((row) => row.slug));
  return rows.map((row) => ({ ...row, tags: bySlug.get(row.slug) ?? [] }));
}

function searchHits(q: string, tag: string): SearchHit[] {
  const pattern = likePattern(q);
  const params: unknown[] = [pattern, pattern, pattern, pattern, pattern, pattern];
  let sql = `SELECT ${ARTICLE_COLUMNS}, search_text,
      CASE
        WHEN title_ko LIKE ? ESCAPE '\\' THEN 3
        WHEN lede_ko LIKE ? ESCAPE '\\' THEN 2
        WHEN search_text LIKE ? ESCAPE '\\' THEN 1
        ELSE 0
      END AS rank
    FROM articles
    WHERE (
      title_ko LIKE ? ESCAPE '\\'
      OR lede_ko LIKE ? ESCAPE '\\'
      OR search_text LIKE ? ESCAPE '\\'
    )`;
  if (tag) {
    sql +=
      " AND EXISTS (SELECT 1 FROM article_tags t WHERE t.slug = articles.slug AND t.tag = ?)";
    params.push(tag);
  }
  sql += " ORDER BY rank DESC, published_at DESC LIMIT 20";
  return query<SearchHit>(sql, params);
}

/** 같은 태그를 많이 공유하는 기사부터. 모자라면 최신 기사로 채운다(내부 링크). */
function relatedArticles(slug: string, tags: string[], limit = 5): RelatedRow[] {
  const out: RelatedRow[] = [];
  const seen = new Set([slug]);
  if (tags.length > 0) {
    const marks = tags.map(() => "?").join(", ");
    // 태그에서 출발해야 idx_article_tags_tag를 쓴다(기사 전체 스캔 방지).
    const rows = query<RelatedRow & { shared: number }>(
      `SELECT a.slug, a.title_ko, a.published_at, COUNT(*) AS shared
        FROM article_tags t
        JOIN articles a ON a.slug = t.slug
        WHERE t.tag IN (${marks}) AND t.slug <> ?
        GROUP BY t.slug
        ORDER BY shared DESC, a.published_at DESC
        LIMIT ?`,
      [...tags, slug, limit],
    );
    for (const row of rows) {
      out.push({ slug: row.slug, title_ko: row.title_ko, published_at: row.published_at });
      seen.add(row.slug);
    }
  }
  if (out.length < limit) {
    const fill = query<RelatedRow>(
      "SELECT slug, title_ko, published_at FROM articles WHERE slug <> ? ORDER BY published_at DESC LIMIT ?",
      [slug, limit * 2 + 1],
    );
    for (const row of fill) {
      if (out.length >= limit) break;
      if (seen.has(row.slug)) continue;
      out.push(row);
      seen.add(row.slug);
    }
  }
  return out;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function bearerOk(c: Context): boolean {
  const header = c.req.header("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length).trim();
  if (!token) return false;
  const given = createHash("sha256").update(token).digest();
  const expected = createHash("sha256").update(env.apiKey).digest();
  return timingSafeEqual(given, expected);
}

function sameOrigin(c: Context): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = c.req.header("Host") ?? new URL(c.req.url).host;
  return originHost === host;
}

app.use(compress());
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  await next();
});

// 순서: health 예외 → clientIp/세션 확보 → Origin 검사(POST) → rate limit → 라우트
app.use("*", async (c, next) => {
  if (c.req.path === "/health" || isCacheableAsset(c.req.path)) {
    await next();
    return;
  }
  const ip = clientIp(c);
  c.set("ip", ip);
  c.set("sid", ensureSession(c));

  if (c.req.method === "POST" && !sameOrigin(c)) {
    return wantsPartial(c)
      ? c.html(noticeFragment("다른 사이트에서 보낸 요청은 처리할 수 없습니다."), 403)
      : c.html(messagePage("요청 거부", "다른 사이트에서 보낸 요청은 처리할 수 없습니다."), 403);
  }

  const global = consume(`global:${ip}`, 300, 60_000);
  if (!global.ok) {
    c.header("Retry-After", String(global.retryAfter));
    return wantsPartial(c)
      ? c.html(noticeFragment("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."), 429)
      : c.html(
        messagePage("요청 제한", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."),
        429,
      );
  }

  if (c.req.method === "GET" && c.req.path === "/search") {
    const search = consume(`search:${ip}`, 60, 60_000);
    if (!search.ok) {
      c.header("Retry-After", String(search.retryAfter));
      return wantsPartial(c)
        ? c.html(noticeFragment("검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."), 429)
        : c.html(
          messagePage(
            "요청 제한",
            "검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
          ),
          429,
        );
    }
  }

  await next();
});

app.get("/health", (c) => c.text("ok"));

app.get("/", (c) => {
  const tag = (c.req.query("tag") ?? "").trim();
  const rawPage = Number(c.req.query("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const where = tag
    ? "WHERE EXISTS (SELECT 1 FROM article_tags t WHERE t.slug = articles.slug AND t.tag = ?)"
    : "";
  const filter = tag ? [tag] : [];
  const total =
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM articles ${where}`, filter)?.n ?? 0;
  const articles = query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles ${where}
     ORDER BY published_at DESC LIMIT ? OFFSET ?`,
    [...filter, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  return c.html(
    feedPage({ articles: withTags(articles), tag, page, total, origin: originOf(c) }),
  );
});

app.get("/tags", (c) => {
  const rawPage = Number(c.req.query("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  return c.html(
    tagsPage({
      tags: allTags(page),
      page,
      total: tagTotal(),
      activeTag: (c.req.query("tag") ?? "").trim(),
      origin: originOf(c),
    }),
  );
});

app.get("/search", (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, QUERY_MAX);
  const tag = (c.req.query("tag") ?? "").trim();
  let notice: string | undefined;
  if (q.length === 0) notice = "검색어를 입력하세요.";
  else if (q.length < QUERY_MIN) notice = `${QUERY_MIN}자 이상 입력해 주세요.`;
  const hits = notice ? [] : withTags(searchHits(q, tag));
  const options = { hits, q, tag, notice, origin: originOf(c) };
  return c.html(wantsPartial(c) ? searchResults(options) : searchPage(options));
});

app.get("/s/:slug", (c) => {
  const slug = c.req.param("slug");
  const article = queryOne<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE slug = ?`,
    [slug],
  );
  if (!article) return c.html(notFoundPage(), 404);
  const tagged = withTags([article])[0];
  return c.html(
    articlePage({
      article: tagged,
      comments: commentsFor(slug),
      commentCount: commentTotal(slug),
      sessionId: c.get("sid"),
      origin: originOf(c),
      related: relatedArticles(slug, tagged.tags ?? []),
    }),
  );
});

app.get("/rss.xml", (c) => {
  const origin = originOf(c);
  const articles = query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles ORDER BY published_at DESC LIMIT 20`,
  );
  const tags = tagsFor(articles.map((article) => article.slug));
  const items = articles
    .map((article) => {
      const url = `${origin}/s/${encodeURIComponent(article.slug)}`;
      const date = new Date(article.published_at);
      const pubDate = Number.isNaN(date.getTime())
        ? xmlEscape(article.published_at)
        : date.toUTCString();
      const category = (tags.get(article.slug) ?? [])
        .map((tag) => `      <category>${xmlEscape(tag)}</category>`)
        .join("\n");
      return [
        "    <item>",
        `      <title>${xmlEscape(article.title_ko)}</title>`,
        `      <link>${xmlEscape(url)}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(url)}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <description>${xmlEscape(article.lede_ko || article.title_ko)}</description>`,
        category,
        "    </item>",
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(SITE_NAME)} · ${xmlEscape(SITE_TAGLINE)}</title>
    <link>${xmlEscape(`${origin}/`)}</link>
    <atom:link href="${xmlEscape(`${origin}/rss.xml`)}" rel="self" type="application/rss+xml" />
    <description>${xmlEscape(SITE_DESCRIPTION)}</description>
    <language>ko</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>30</ttl>
${items}
  </channel>
</rss>
`;
  return c.body(body, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
});

type SitemapArticle = {
  slug: string;
  title_ko: string;
  published_at: string;
  updated_at: string;
};

function imageBlock(origin: string, slug: string, title: string): string {
  const loc = xmlEscape(`${origin}/og/s/${encodeURIComponent(slug)}.png`);
  return `    <image:image>
      <image:loc>${loc}</image:loc>
      <image:title>${xmlEscape(title)}</image:title>
    </image:image>`;
}

/** 전체 URL 목록: 홈·태그 목록·태그 피드·기사(OG 이미지 포함). */
app.get("/sitemap.xml", (c) => {
  const origin = originOf(c);
  const articles = query<SitemapArticle>(
    "SELECT slug, title_ko, published_at, updated_at FROM articles ORDER BY published_at DESC",
  );
  const tags = query<{ tag: string; last: string }>(
    `SELECT t.tag AS tag, MAX(a.updated_at) AS last
     FROM article_tags t JOIN articles a ON a.slug = t.slug
     GROUP BY t.tag ORDER BY last DESC`,
  );

  const entries: string[] = [];
  const homeLast = articles[0]?.updated_at;
  entries.push(
    `  <url><loc>${xmlEscape(`${origin}/`)}</loc>${
      homeLast ? `<lastmod>${xmlEscape(homeLast)}</lastmod>` : ""
    }<changefreq>hourly</changefreq></url>`,
  );
  entries.push(
    `  <url><loc>${xmlEscape(`${origin}/tags`)}</loc>${
      homeLast ? `<lastmod>${xmlEscape(homeLast)}</lastmod>` : ""
    }</url>`,
  );
  for (const row of tags) {
    entries.push(
      `  <url><loc>${xmlEscape(`${origin}/?tag=${encodeURIComponent(row.tag)}`)}</loc>` +
        `<lastmod>${xmlEscape(row.last)}</lastmod></url>`,
    );
  }
  for (const article of articles) {
    entries.push(
      `  <url>
    <loc>${xmlEscape(`${origin}/s/${encodeURIComponent(article.slug)}`)}</loc>
    <lastmod>${xmlEscape(article.updated_at || article.published_at)}</lastmod>
${imageBlock(origin, article.slug, article.title_ko)}
  </url>`,
    );
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.join("\n")}
</urlset>
`;
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8" });
});

/** Google 뉴스 사이트맵: 최근 48시간 기사만. */
app.get("/sitemap-news.xml", (c) => {
  const origin = originOf(c);
  const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
  const articles = query<SitemapArticle>(
    `SELECT slug, title_ko, published_at, updated_at FROM articles
     WHERE datetime(published_at) >= datetime(?)
     ORDER BY published_at DESC LIMIT 1000`,
    [cutoff],
  );
  const urls = articles
    .map((article) => {
      const path = `/s/${encodeURIComponent(article.slug)}`;
      return `  <url>
    <loc>${xmlEscape(origin + path)}</loc>
    <news:news>
      <news:publication>
        <news:name>${xmlEscape(SITE_NAME)}</news:name>
        <news:language>ko</news:language>
      </news:publication>
      <news:publication_date>${xmlEscape(article.published_at)}</news:publication_date>
      <news:title>${xmlEscape(article.title_ko)}</news:title>
    </news:news>
${imageBlock(origin, article.slug, article.title_ko)}
  </url>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>
`;
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8" });
});

/** 검색·미리보기 봇은 허용하고 AI 학습 수집과 저가치 SEO 크롤러는 막는다. */
const AI_TRAINING_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
  "Bytespider",
  "CCBot",
  "AI2Bot",
  "cohere-ai",
  "FacebookBot",
  "meta-externalagent",
  "ImagesiftBot",
  "omgili",
  "omgilibot",
];
const AI_SEARCH_BOTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "GoogleOther",
];
const LOW_VALUE_BOTS = [
  "AhrefsBot",
  "SemrushBot",
  "SemrushBot-BA",
  "MJ12bot",
  "DotBot",
  "PetalBot",
  "DataForSeoBot",
  "SERankingBacklinksBot",
  "Baiduspider",
];

function botGroup(bots: string[], rule: "Allow: /" | "Disallow: /"): string {
  return [...bots.map((bot) => `User-agent: ${bot}`), rule].join("\n");
}

app.get("/robots.txt", (c) => {
  const origin = originOf(c);
  const body = [
    "Content-Signal: ai-train=no, search=yes, ai-input=yes",
    "",
    "# AI 학습용 수집기는 막고, 검색·사용자 요청 봇은 허용한다.",
    botGroup(AI_TRAINING_BOTS, "Disallow: /"),
    "",
    botGroup(AI_SEARCH_BOTS, "Allow: /"),
    "",
    "# 저가치 SEO 크롤러.",
    botGroup(LOW_VALUE_BOTS, "Disallow: /"),
    "",
    "User-agent: *",
    "Allow: /",
    "Disallow: /internal/",
    "Disallow: /search",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    `Sitemap: ${origin}/sitemap-news.xml`,
    "",
  ].join("\n");
  return c.body(body, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

let htmxAsset: string | null | undefined;

app.get("/assets/htmx.min.js", (c) => {
  if (htmxAsset === undefined) {
    try {
      htmxAsset = readFileSync(join(rootDir, "dist/htmx.min.js"), "utf8");
    } catch {
      htmxAsset = null;
    }
  }
  if (!htmxAsset) return c.text("htmx 파일을 찾을 수 없습니다.", 404);
  c.header("Cache-Control", "no-cache");
  return c.body(htmxAsset, 200, { "Content-Type": "text/javascript; charset=utf-8" });
});

const ICON_MAX_AGE = 30 * 24 * 3600;

app.get("/assets/favicon.svg", (c) => {
  c.header("Cache-Control", `public, max-age=${ICON_MAX_AGE}`);
  return c.body(logoSvg(64), 200, { "Content-Type": "image/svg+xml; charset=utf-8" });
});

for (const [path, size] of [
  ["/assets/icon-192.png", 192],
  ["/assets/icon-512.png", 512],
  ["/assets/apple-touch-icon.png", 180],
  ["/favicon.ico", 48],
] as const) {
  app.get(path, (c) => pngResponse(c, logoPng(size), ICON_MAX_AGE));
}

app.get("/site.webmanifest", (c) => {
  c.header("Cache-Control", `public, max-age=${ICON_MAX_AGE}`);
  return c.body(manifestJson(), 200, {
    "Content-Type": "application/manifest+json; charset=utf-8",
  });
});

/** 기사 OG 카드. `/og/s/:slug.png` 와 사이트 기본 카드 `/og/default.png`. */
app.get("/og/*", async (c) => {
  const rest = c.req.path.slice("/og/".length);
  if (rest === "default.png" || rest === "") {
    return pngResponse(c, await ogPng(DEFAULT_OG_KEY, defaultOgCard()), 3600);
  }
  if (!rest.startsWith("s/") || !rest.endsWith(".png")) {
    return c.text("not found", 404);
  }
  const slug = decodeURIComponent(rest.slice(2, -4));
  const article = queryOne<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE slug = ?`,
    [slug],
  );
  if (!article) return c.text("not found", 404);
  const card = articleOgCard(withTags([article])[0]);
  return pngResponse(c, await ogPng(`${slug}@${article.updated_at}`, card), 86400);
});

app.post("/s/:slug/comments", async (c) => {
  const slug = c.req.param("slug");
  const partial = wantsPartial(c);
  if (!articleExists(slug)) {
    return partial
      ? c.html(commentError("기사를 찾을 수 없습니다."), 404)
      : c.html(notFoundPage(), 404);
  }
  const redirectTo = () => c.redirect(`/s/${encodeURIComponent(slug)}#comments`, 303);

  const form = await c.req.parseBody();
  const honeypot = String(form[HONEYPOT_FIELD] ?? "").trim();
  if (honeypot) {
    // 봇으로 보이면 조용히 무시한다.
    return partial ? c.html(commentCount(commentTotal(slug)), 200) : redirectTo();
  }

  const nickname = String(form.nickname ?? "").trim();
  const body = String(form.body ?? "").trim();
  const sid = c.get("sid");

  if (!isRateLimitDisabled()) {
    const recent = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM comments WHERE session_id = ? AND created_at > ?",
      [sid, new Date(Date.now() - 30_000).toISOString()],
    );
    const hourly = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ? AND created_at > ?",
      [hashIp(c.get("ip")), new Date(Date.now() - 3_600_000).toISOString()],
    );
    if ((recent?.n ?? 0) >= 1 || (hourly?.n ?? 0) >= 10) {
      const message = "댓글은 30초에 하나만, IP당 1시간에 10개까지 쓸 수 있습니다.";
      c.header("Retry-After", "30");
      return partial
        ? c.html(commentError(message), 429)
        : c.html(messagePage("댓글 제한", message), 429);
    }
  }

  let error: string | undefined;
  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    error = `내용은 ${BODY_MIN}자 이상 ${BODY_MAX}자 이하로 입력해 주세요.`;
  } else if (nickname.length > NICKNAME_MAX) {
    error = `닉네임은 ${NICKNAME_MAX}자 이하로 입력해 주세요.`;
  }
  if (error) {
    return partial
      ? c.html(commentError(error), 422)
      : c.html(messagePage("댓글을 등록할 수 없습니다", error), 400);
  }

  const info = run(
    `INSERT INTO comments (slug, nickname, body, session_id, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [slug, nickname || "익명", body, sid, hashIp(c.get("ip")), nowIso()],
  );
  const created = queryOne<CommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM comments WHERE id = ?`,
    [info.lastInsertRowid],
  );
  if (!created) return redirectTo();
  if (!partial) return redirectTo();
  // 성공했을 때만 폼을 비우도록 클라이언트 이벤트를 쏜다(429/422에서는 입력을 보존).
  c.header("HX-Trigger", "commentPosted");
  return c.html(
    html`${commentItem(created, sid)}${commentErrorClear()}${commentCount(commentTotal(slug))}${commentEmptyClear()}`,
    201,
  );
});

app.post("/comments/:id/delete", (c) => {
  const id = Number(c.req.param("id"));
  const partial = wantsPartial(c);
  const sid = c.get("sid");
  const row = Number.isInteger(id)
    ? queryOne<{ id: number; slug: string; session_id: string }>(
      "SELECT id, slug, session_id FROM comments WHERE id = ? AND deleted_at IS NULL",
      [id],
    )
    : undefined;

  if (!row) {
    return partial
      ? c.html(commentError("댓글을 찾을 수 없습니다."), 404)
      : c.html(messagePage("없는 댓글", "댓글을 찾을 수 없습니다."), 404);
  }
  if (row.session_id !== sid) {
    return partial
      ? c.html(commentError("본인 댓글만 삭제할 수 있습니다."), 403)
      : c.html(messagePage("삭제 불가", "본인 댓글만 삭제할 수 있습니다."), 403);
  }

  run("UPDATE comments SET deleted_at = ? WHERE id = ?", [nowIso(), id]);
  if (!partial) return c.redirect(`/s/${encodeURIComponent(row.slug)}#comments`, 303);
  return c.html(
    html`${commentTombstone(id)}${commentCount(commentTotal(row.slug))}`,
    200,
  );
});

app.use("/internal/*", async (c, next) => {
  if (!bearerOk(c)) return c.json({ error: "unauthorized" }, 401);
  const limit = consume(`internal:${c.get("ip")}`, 120, 60_000);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfter));
    return c.json({ error: "rate limited" }, 429);
  }
  await next();
});

type SourceIn = { name?: unknown; url?: unknown; role?: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStoryId(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** 레거시 section → 태그 1개. 매핑에 없으면 null(기존 태그 유지). */
function legacyTag(value: unknown): string[] | null {
  const tag = LEGACY_SECTION_TAGS[asString(value)?.trim() ?? ""];
  return tag ? [tag] : null;
}

function normalizeComments(value: unknown): { author: string; text: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { author: string; text: string }[] = [];
  for (const item of value) {
    const row = (item ?? {}) as { author?: unknown; text?: unknown };
    const text = asString(row.text)?.trim();
    if (!text) continue;
    out.push({ author: asString(row.author)?.trim() ?? "", text });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeSources(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = (item ?? {}) as SourceIn & { comments?: unknown };
    const rec: Record<string, unknown> = {
      name: asString(source.name) ?? "",
      url: asString(source.url) ?? "",
      role: asString(source.role) ?? "",
    };
    const comments = normalizeComments(source.comments);
    if (comments.length) rec.comments = comments;
    return rec;
  });
}

app.post("/internal/articles", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid json" }, 400);
  }

  const input = body as Record<string, unknown>;
  const slug = asString(input.slug)?.trim();
  const title_ko = asString(input.title_ko);
  const raw_body_html = asString(input.body_html);
  const published_at = asString(input.published_at);
  const updated_at = asString(input.updated_at);
  if (
    !slug ||
    title_ko == null ||
    raw_body_html == null ||
    !published_at ||
    !updated_at
  ) {
    return c.json(
      { error: "slug, title_ko, body_html, published_at, updated_at are required" },
      400,
    );
  }

  const body_html = sanitizeBodyHtml(raw_body_html);
  const lede_ko = asString(input.lede_ko) ?? "";
  const story_id = asStoryId(input.story_id);
  const sources_json = JSON.stringify(normalizeSources(input.sources));
  const search_text = toSearchText(body_html);

  // tags 키가 없으면 기존 태그를 유지한다. 레거시 section은 태그 1개로 변환한다.
  const hasTags = Object.hasOwn(input, "tags");
  if (hasTags && !Array.isArray(input.tags)) {
    return c.json({ error: "tags must be an array" }, 400);
  }
  const tags = hasTags ? normalizeTags(input.tags) : legacyTag(input.section);

  const existing = query<{ slug: string }>(
    "SELECT slug FROM articles WHERE slug = ?",
    [slug],
  );
  if (existing.length > 0) {
    transaction(() => {
      run(
        `UPDATE articles SET
          title_ko = ?, lede_ko = ?, body_html = ?,
          published_at = ?, updated_at = ?, story_id = ?, sources_json = ?, search_text = ?
        WHERE slug = ?`,
        [
          title_ko,
          lede_ko,
          body_html,
          published_at,
          updated_at,
          story_id,
          sources_json,
          search_text,
          slug,
        ],
      );
      if (tags !== null) replaceTags(slug, tags);
    });
    return c.json({ ok: true, slug }, 200);
  }

  transaction(() => {
    run(
      `INSERT INTO articles (
        slug, title_ko, lede_ko, body_html,
        published_at, updated_at, story_id, sources_json, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        title_ko,
        lede_ko,
        body_html,
        published_at,
        updated_at,
        story_id,
        sources_json,
        search_text,
      ],
    );
    if (tags !== null) replaceTags(slug, tags);
  });
  return c.json({ ok: true, slug }, 201);
});

app.delete("/internal/comments/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid id" }, 400);
  const info = run(
    "UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    [nowIso(), id],
  );
  if (info.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, id });
});

app.notFound((c) => c.html(pageNotFoundPage(), 404));

app.onError((err, c) => {
  console.error("[web] 오류:", err);
  return c.html(
    messagePage("서버 오류", "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."),
    500,
  );
});
