import { createHmac } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { env, isRateLimitDisabled } from "./env.ts";

/** IPv4-mapped IPv6(`::ffff:1.2.3.4`)를 IPv4로 정규화한다. */
export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

/** TRUST_PROXY=cloudflare면 CF-Connecting-IP, 아니면 소켓 주소. */
export function clientIp(c: Context): string {
  if (env.trustProxy) {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    if (cf) return normalizeIp(cf);
  }
  try {
    const info = getConnInfo(c);
    return normalizeIp(info.remote.address ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** 댓글 IP 누적 판정용 해시. 원본 IP는 저장하지 않는다. */
export function hashIp(ip: string): string {
  return createHmac("sha256", env.sessionSecret).update(ip).digest("hex").slice(0, 32);
}

type Stamps = number[];

const DEFAULT_WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;
const PRUNE_INTERVAL_MS = 30_000;

const buckets = new Map<string, Stamps>();

function prune(): void {
  const cutoff = Date.now() - DEFAULT_WINDOW_MS;
  for (const [key, stamps] of buckets) {
    const alive = stamps.filter((at) => at > cutoff);
    if (alive.length === 0) buckets.delete(key);
    else buckets.set(key, alive);
  }
}

const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
pruneTimer.unref();

export type LimitResult = { ok: boolean; retryAfter: number };

/** 인메모리 슬라이딩 윈도우. 초과하면 ok=false + Retry-After 초. */
export function consume(key: string, limit: number, windowMs = DEFAULT_WINDOW_MS): LimitResult {
  if (isRateLimitDisabled()) return { ok: true, retryAfter: 0 };
  const now = Date.now();
  const cutoff = now - windowMs;
  let stamps = buckets.get(key);
  if (!stamps) {
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    stamps = [];
    buckets.set(key, stamps);
  }
  while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
  if (stamps.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
    return { ok: false, retryAfter };
  }
  stamps.push(now);
  return { ok: true, retryAfter: 0 };
}

/** 테스트용 초기화. */
export function resetRateLimits(): void {
  buckets.clear();
}
