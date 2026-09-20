import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

config({ path: join(rootDir, ".env") });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다. web/.env 또는 .env.example을 확인하세요.`);
  }
  return value;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} 값이 올바르지 않습니다: ${raw}`);
  }
  return value;
}

function bool(name: string): boolean {
  return process.env[name]?.trim() === "1";
}

export const env = {
  /** /internal/* Bearer 키. writer와 공유한다. */
  apiKey: required("WEB_API_KEY"),
  /** 세션 쿠키 HMAC 키. */
  sessionSecret: required("SESSION_SECRET"),
  port: port("PORT", 8787),
  host: process.env.HOST?.trim() || "127.0.0.1",
  dbPath: process.env.WEB_DB?.trim() || join(rootDir, "data", "web.db"),
  /** cloudflare면 CF-Connecting-IP를 실제 IP로 신뢰한다. */
  trustProxy: process.env.TRUST_PROXY?.trim() === "cloudflare",
  /** OG/RSS/sitemap 절대 URL. 빈 값이면 상대경로를 쓴다. */
  siteUrl: (process.env.SITE_URL?.trim() || "").replace(/\/+$/, ""),
  cookieSecure: bool("COOKIE_SECURE"),
};

/** 부하 테스트용 스위치. 테스트에서 런타임에 토글할 수 있게 매번 읽는다. */
export function isRateLimitDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED?.trim() === "1";
}
