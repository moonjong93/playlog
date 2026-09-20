import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, run } from "./db.ts";
import {
  articlePage,
  listPage,
  notFoundPage,
  type ArticleRow,
} from "./pages.ts";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const apiKey = process.env.WEB_API_KEY;
if (!apiKey) {
  console.error("WEB_API_KEY is required");
  process.exit(1);
}

const port = Number(process.env.PORT || 8787);
const app = new Hono();

function requestKey(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | undefined {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const fromQuery = c.req.query("key");
  return fromQuery || undefined;
}

function queryKey(c: { req: { query: (name: string) => string | undefined } }): string | undefined {
  return c.req.query("key") || undefined;
}

app.get("/health", (c) => c.text("ok"));

app.use("*", async (c, next) => {
  if (c.req.path === "/health") {
    await next();
    return;
  }
  const provided = requestKey(c);
  if (!provided || provided !== apiKey) {
    return c.text("unauthorized", 401);
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
  const body_html = asString(input.body_html);
  const published_at = asString(input.published_at);
  const updated_at = asString(input.updated_at);
  if (!slug || title_ko == null || body_html == null || !published_at || !updated_at) {
    return c.json(
      { error: "slug, title_ko, body_html, published_at, updated_at are required" },
      400,
    );
  }

  const lede_ko = asString(input.lede_ko) ?? "";
  const section = asString(input.section) ?? "";
  const story_id = asStoryId(input.story_id);
  const sources_json = JSON.stringify(normalizeSources(input.sources));

  const existing = query<{ slug: string }>(
    "SELECT slug FROM articles WHERE slug = ?",
    [slug],
  );
  if (existing.length > 0) {
    run(
      `UPDATE articles SET
        title_ko = ?, lede_ko = ?, body_html = ?, section = ?,
        published_at = ?, updated_at = ?, story_id = ?, sources_json = ?
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
        slug,
      ],
    );
    return c.json({ ok: true, slug }, 200);
  }

  run(
    `INSERT INTO articles (
      slug, title_ko, lede_ko, body_html, section,
      published_at, updated_at, story_id, sources_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
  return c.json({ ok: true, slug }, 201);
});

app.get("/", (c) => {
  const articles = query<ArticleRow>(
    `SELECT slug, title_ko, lede_ko, body_html, section,
            published_at, updated_at, story_id, sources_json
     FROM articles
     ORDER BY published_at DESC
     LIMIT 20`,
  );
  return c.html(listPage(articles, queryKey(c)));
});

app.get("/s/:slug", (c) => {
  const slug = c.req.param("slug");
  const rows = query<ArticleRow>(
    `SELECT slug, title_ko, lede_ko, body_html, section,
            published_at, updated_at, story_id, sources_json
     FROM articles WHERE slug = ?`,
    [slug],
  );
  const article = rows[0];
  if (!article) {
    return c.html(notFoundPage(queryKey(c)), 404);
  }
  return c.html(articlePage(article, queryKey(c)));
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`listening on http://127.0.0.1:${info.port}`);
});
