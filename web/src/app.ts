import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { html } from "hono/html";
import { query, queryOne, run } from "./db.ts";
import { env, isRateLimitDisabled, rootDir } from "./env.ts";
import { clientIp, consume, hashIp } from "./ratelimit.ts";
import { ensureSession } from "./session.ts";
import { sanitizeBodyHtml, toSearchText } from "./sanitize.ts";
import { normalizeSection } from "./sections.ts";
import { PAGE_SIZE, feedPage } from "./pages/feed.ts";
import { articlePage } from "./pages/article.ts";
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

type AppEnv = { Variables: { ip: string; sid: string } };

export const app = new Hono<AppEnv>();

const ARTICLE_COLUMNS = `slug, title_ko, lede_ko, body_html, section,
  published_at, updated_at, story_id, sources_json`;

const COMMENT_COLUMNS = "id, nickname, body, session_id, created_at";

function nowIso(): string {
  return new Date().toISOString();
}

function wantsPartial(c: Context): boolean {
  return c.req.header("HX-Request-Type") === "partial";
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

function searchHits(q: string, section: string): SearchHit[] {
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
  if (section) {
    sql += " AND section = ?";
    params.push(section);
  }
  sql += " ORDER BY rank DESC, published_at DESC LIMIT 20";
  return query<SearchHit>(sql, params);
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
  if (c.req.path === "/health") {
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
  const section = normalizeSection(c.req.query("section") ?? "");
  const rawPage = Number(c.req.query("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const where = section ? "WHERE section = ?" : "";
  const filter = section ? [section] : [];
  const total =
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM articles ${where}`, filter)?.n ?? 0;
  const articles = query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles ${where}
     ORDER BY published_at DESC LIMIT ? OFFSET ?`,
    [...filter, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  return c.html(feedPage({ articles, section, page, total }));
});

app.get("/search", (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, QUERY_MAX);
  const section = normalizeSection(c.req.query("section") ?? "");
  let notice: string | undefined;
  if (q.length === 0) notice = "검색어를 입력하세요.";
  else if (q.length < QUERY_MIN) notice = `${QUERY_MIN}자 이상 입력해 주세요.`;
  const hits = notice ? [] : searchHits(q, section);
  const options = { hits, q, section, notice };
  return c.html(wantsPartial(c) ? searchResults(options) : searchPage(options));
});

app.get("/s/:slug", (c) => {
  const slug = c.req.param("slug");
  const article = queryOne<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE slug = ?`,
    [slug],
  );
  if (!article) return c.html(notFoundPage(), 404);
  return c.html(
    articlePage({
      article,
      comments: commentsFor(slug),
      commentCount: commentTotal(slug),
      sessionId: c.get("sid"),
    }),
  );
});

app.get("/rss.xml", (c) => {
  const articles = query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM articles ORDER BY published_at DESC LIMIT 20`,
  );
  const items = articles
    .map((article) => {
      const path = `/s/${encodeURIComponent(article.slug)}`;
      const date = new Date(article.published_at);
      return [
        "    <item>",
        `      <title>${xmlEscape(article.title_ko)}</title>`,
        `      <link>${xmlEscape(env.siteUrl + path)}</link>`,
        `      <guid isPermaLink="false">${xmlEscape(path)}</guid>`,
        `      <pubDate>${
          Number.isNaN(date.getTime()) ? xmlEscape(article.published_at) : date.toUTCString()
        }</pubDate>`,
        `      <description>${xmlEscape(article.lede_ko)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Ludus Digest</title>
    <link>${xmlEscape(env.siteUrl || "/")}</link>
    <description>게임 업계 뉴스 다이제스트</description>
    <language>ko</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  return c.body(body, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
});

app.get("/sitemap.xml", (c) => {
  const rows = query<{ slug: string; published_at: string }>(
    "SELECT slug, published_at FROM articles ORDER BY published_at DESC",
  );
  const urls = rows
    .map((row) => {
      const path = `/s/${encodeURIComponent(row.slug)}`;
      return `  <url><loc>${xmlEscape(env.siteUrl + path)}</loc><lastmod>${xmlEscape(
        row.published_at,
      )}</lastmod></url>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8" });
});

app.get("/robots.txt", (c) => {
  const lines = ["User-agent: *", "Allow: /", "Disallow: /internal/"];
  if (env.siteUrl) lines.push(`Sitemap: ${env.siteUrl}/sitemap.xml`);
  return c.body(`${lines.join("\n")}\n`, 200, {
    "Content-Type": "text/plain; charset=utf-8",
  });
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
  const section = normalizeSection(asString(input.section) ?? "");
  const story_id = asStoryId(input.story_id);
  const sources_json = JSON.stringify(normalizeSources(input.sources));
  const search_text = toSearchText(body_html);

  const existing = query<{ slug: string }>(
    "SELECT slug FROM articles WHERE slug = ?",
    [slug],
  );
  if (existing.length > 0) {
    run(
      `UPDATE articles SET
        title_ko = ?, lede_ko = ?, body_html = ?, section = ?,
        published_at = ?, updated_at = ?, story_id = ?, sources_json = ?, search_text = ?
      WHERE slug = ?`,
      [
        title_ko,
        lede_ko,
        body_html,
        section,
        published_at,
        updated_at,
        story_id,
        sources_json,
        search_text,
        slug,
      ],
    );
    return c.json({ ok: true, slug }, 200);
  }

  run(
    `INSERT INTO articles (
      slug, title_ko, lede_ko, body_html, section,
      published_at, updated_at, story_id, sources_json, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      slug,
      title_ko,
      lede_ko,
      body_html,
      section,
      published_at,
      updated_at,
      story_id,
      sources_json,
      search_text,
    ],
  );
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
