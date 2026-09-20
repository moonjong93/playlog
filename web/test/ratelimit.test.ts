import { afterAll, describe, expect, it } from "vitest";
import {
  app,
  cleanup,
  insertArticle,
  resetRateLimits,
  setRateLimitDisabled,
} from "./helpers.ts";

insertArticle({ slug: "rate-target", title: "리밋 대상 기사" });

afterAll(() => cleanup());

const partial = { headers: { "HX-Request-Type": "partial" } };

describe("레이트 리밋", () => {
  it("RATE_LIMIT_DISABLED=1이면 리밋을 무시한다", async () => {
    setRateLimitDisabled(true);
    resetRateLimits();
    for (let i = 0; i < 65; i += 1) {
      const res = await app.request("/search?q=TGS", partial);
      expect(res.status).toBe(200);
    }
  });

  it("검색은 IP당 60/분", async () => {
    setRateLimitDisabled(false);
    resetRateLimits();
    for (let i = 0; i < 60; i += 1) {
      const res = await app.request("/search?q=TGS", partial);
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/search?q=TGS", partial);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(await blocked.text()).toContain("검색 요청이 너무 많습니다");
  });

  it("전역 IP 리밋은 300/분 + Retry-After", async () => {
    setRateLimitDisabled(false);
    resetRateLimits();
    for (let i = 0; i < 300; i += 1) {
      expect((await app.request("/rss.xml")).status).toBe(200);
    }
    const blocked = await app.request("/rss.xml");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(await blocked.text()).toContain("요청이 너무 많습니다");
  });
});
