import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// env.ts는 import 시점에 환경변수를 검증하므로 반드시 먼저 설정한다.
const tempDir = mkdtempSync(join(tmpdir(), "news-web-test-"));
process.env.WEB_DB = join(tempDir, "web.db");
process.env.SESSION_SECRET ??= "test-session-secret";
process.env.WEB_API_KEY ??= "test-api-key";
delete process.env.TRUST_PROXY;
delete process.env.SITE_URL;

export const { app } = await import("../src/app.ts");
export const { query, run, close } = await import("../src/db.ts");
export const { hashIp, resetRateLimits } = await import("../src/ratelimit.ts");
export const { sanitizeBodyHtml, toSearchText } = await import("../src/sanitize.ts");
export const { verifySessionId, SESSION_COOKIE, SESSION_MAX_AGE } = await import(
  "../src/session.ts"
);

export const API_KEY = process.env.WEB_API_KEY;

export function cleanup(): void {
  try {
    close();
  } catch {
    // 이미 닫혔으면 무시한다.
  }
  rmSync(tempDir, { recursive: true, force: true });
}

export function setRateLimitDisabled(disabled: boolean): void {
  if (disabled) process.env.RATE_LIMIT_DISABLED = "1";
  else process.env.RATE_LIMIT_DISABLED = "0";
}

/** 응답의 Set-Cookie에서 쿠키 값을 뽑는다. 없으면 undefined. */
export function cookieValue(res: Response, name: string): string | undefined {
  const headers =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const header of headers) {
    if (!header.startsWith(`${name}=`)) continue;
    return header.slice(name.length + 1).split(";")[0];
  }
  return undefined;
}

export function sessionCookie(res: Response): string | undefined {
  return cookieValue(res, SESSION_COOKIE);
}

/** 첫 요청으로 세션 쿠키를 발급받는다. */
export async function newSessionCookie(path = "/"): Promise<string> {
  const res = await app.request(path);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error("세션 쿠키가 발급되지 않았습니다");
  return cookie;
}

export function insertArticle(options: {
  slug: string;
  title?: string;
  lede?: string;
  body?: string;
  section?: string;
  publishedAt?: string;
  sources?: unknown[];
}): void {
  const title = options.title ?? options.slug;
  const body = options.body ?? `<p>${title} 본문입니다.</p>`;
  const published = options.publishedAt ?? "2026-09-19T12:00:00+09:00";
  run(
    `INSERT INTO articles (
      slug, title_ko, lede_ko, body_html, section,
      published_at, updated_at, story_id, sources_json, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.slug,
      title,
      options.lede ?? "",
      body,
      options.section ?? "",
      published,
      published,
      null,
      JSON.stringify(options.sources ?? []),
      toSearchText(body),
    ],
  );
}

export function countArticles(): number {
  return query<{ n: number }>("SELECT COUNT(*) AS n FROM articles")[0].n;
}

export async function postComment(options: {
  slug: string;
  body: string;
  cookie?: string;
  nickname?: string;
  honeypot?: string;
  partial?: boolean;
  origin?: string;
}): Promise<Response> {
  const form = new URLSearchParams();
  if (options.nickname !== undefined) form.set("nickname", options.nickname);
  form.set("body", options.body);
  if (options.honeypot) form.set("website", options.honeypot);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (options.cookie) headers["Cookie"] = `${SESSION_COOKIE}=${options.cookie}`;
  if (options.partial !== false) headers["HX-Request-Type"] = "partial";
  headers["Origin"] = options.origin ?? "http://localhost";
  return app.request(`/s/${options.slug}/comments`, {
    method: "POST",
    headers,
    body: form,
  });
}

export async function postForm(
  path: string,
  fields: Record<string, string>,
  options: { cookie?: string; partial?: boolean; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: options.origin ?? "http://localhost",
  };
  if (options.cookie) headers["Cookie"] = `${SESSION_COOKIE}=${options.cookie}`;
  if (options.partial !== false) headers["HX-Request-Type"] = "partial";
  return app.request(path, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

export async function postInternal(payload: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return app.request("/internal/articles", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}
