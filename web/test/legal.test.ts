import { afterAll, describe, expect, it } from "vitest";
import { app, cleanup } from "./helpers.ts";

afterAll(() => cleanup());

const YEAR = new Date().getFullYear();

describe("푸터 안내·법적 페이지", () => {
  const pages = [
    { path: "/about", heading: "소개", marker: "무엇을 전하나요?", effectiveDate: false },
    { path: "/privacy", heading: "개인정보 처리방침", marker: "익명 세션 쿠키", effectiveDate: true },
    { path: "/terms", heading: "이용약관", marker: "준거법과 분쟁", effectiveDate: true },
    { path: "/contact", heading: "문의", marker: "support.news@nevra.app", effectiveDate: false },
  ];

  for (const page of pages) {
    it(`${page.path}는 200 + 핵심 문구 + canonical`, async () => {
      const res = await app.request(page.path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`<title>${page.heading} · PLAYLOG</title>`);
      expect(body).toContain(page.marker);
      expect(body).toContain(`<link rel="canonical" href="http://localhost${page.path}" />`);
      if (page.effectiveDate) expect(body).toContain("시행일 2026년 9월 26일");
      else expect(body).not.toContain("시행일");
      expect(body).not.toContain("noindex");
    });
  }

  it("소개·약관은 게임 흐름 중심이고 AI 표현을 쓰지 않는다", async () => {
    const about = await (await app.request("/about")).text();
    expect(about).toContain("게임의 흐름");
    expect(about).toContain("공개된 이야기");
    expect(about).not.toContain("인공지능");
    const terms = await (await app.request("/terms")).text();
    expect(terms).not.toContain("인공지능");
    expect(terms).toContain("정리된 내용은 원문을 바탕으로 한 요약");
    const home = await (await app.request("/")).text();
    expect(home).not.toContain("AI Summaries");
  });

  it("모든 페이지 푸터에 안내 링크·문의 메일·저작권 표기가 있다", async () => {
    const home = await (await app.request("/")).text();
    expect(home).toContain('href="/about"');
    expect(home).toContain('href="/privacy"');
    expect(home).toContain('href="/terms"');
    expect(home).toContain('href="mailto:support.news@nevra.app"');
    expect(home).toContain(`© ${YEAR} PLAYLOG`);

    // 안내 페이지에도 같은 푸터가 나온다.
    const about = await (await app.request("/about")).text();
    expect(about).toContain('href="/privacy"');
    expect(about).toContain('href="mailto:support.news@nevra.app"');
  });

  it("sitemap.xml에 안내 페이지 4개가 들어간다", async () => {
    const res = await app.request("/sitemap.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    for (const path of ["/about", "/privacy", "/terms", "/contact"]) {
      expect(xml).toContain(`<loc>http://localhost${path}</loc>`);
    }
  });

  it("문의 페이지는 메일 주소와 응대 안내를 보여준다", async () => {
    const body = await (await app.request("/contact")).text();
    expect(body).toContain('href="mailto:support.news@nevra.app"');
    expect(body).toContain("영업일 기준 2~3일");
    expect(body).toContain("개인정보 관련");
  });
});
