import { afterAll, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  app,
  cleanup,
  insertArticle,
  newSessionCookie,
  sessionCookie,
  verifySessionId,
} from "./helpers.ts";

insertArticle({ slug: "session-target", title: "세션 대상 기사" });

afterAll(() => cleanup());

describe("세션 쿠키", () => {
  it("서명된 sid를 발급한다", async () => {
    const res = await app.request("/");
    const cookie = sessionCookie(res);
    expect(cookie).toBeTruthy();
    const header = res.headers.getSetCookie()[0];
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_MAX_AGE}`);
    expect(header).not.toContain("Secure");

    const [id, mac] = (cookie ?? "").split(".");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySessionId(cookie)).toBe(id);
  });

  it("유효한 쿠키는 다시 발급하지 않는다", async () => {
    const cookie = await newSessionCookie();
    const res = await app.request("/", { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("서명이 틀리면 새로 발급한다", async () => {
    const cookie = await newSessionCookie();
    const [id, mac] = cookie.split(".");
    const tampered = `${id}.${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
    expect(verifySessionId(tampered)).toBeNull();

    const res = await app.request("/", { headers: { Cookie: `${SESSION_COOKIE}=${tampered}` } });
    const fresh = sessionCookie(res);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(tampered);
    expect(verifySessionId(fresh ?? "")).toBe(fresh?.split(".")[0]);
  });

  it("세션은 댓글 소유권 판정에 쓰인다", async () => {
    const cookie = await newSessionCookie();
    const res = await app.request("/s/session-target/comments", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request-Type": "partial",
        Cookie: `${SESSION_COOKIE}=${cookie}`,
      },
      body: new URLSearchParams({ body: "소유권 댓글" }),
    });
    expect(res.status).toBe(201);
    const page = await (
      await app.request("/s/session-target", { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } })
    ).text();
    // 본인 세션에는 삭제 버튼이 보인다.
    expect(page).toContain("댓글 삭제");
  });
});
