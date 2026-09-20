import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { env } from "./env.ts";

export const SESSION_COOKIE = "sid";
export const SESSION_MAX_AGE = 31_536_000; // 1년

function sign(id: string): string {
  return createHmac("sha256", env.sessionSecret).update(id).digest("hex");
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** `<16바이트 hex>.<HMAC-SHA256(secret, id)>` 검증. 실패하면 null. */
export function verifySessionId(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  if (!equalHex(mac, sign(id))) return null;
  return id;
}

/** 쿠키가 유효하면 그대로, 없거나 서명이 틀리면 새로 발급한다. 상태는 저장하지 않는다. */
export function ensureSession(c: Context): string {
  const id = verifySessionId(getCookie(c, SESSION_COOKIE));
  if (id) return id;
  const fresh = randomBytes(16).toString("hex");
  setCookie(c, SESSION_COOKIE, `${fresh}.${sign(fresh)}`, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: env.cookieSecure,
  });
  return fresh;
}
