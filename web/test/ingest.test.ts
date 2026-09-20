import { afterAll, describe, expect, it } from "vitest";
import { API_KEY, app, cleanup, postInternal, query } from "./helpers.ts";

afterAll(() => cleanup());

const payload = {
  slug: "ingest-brief",
  title_ko: "발행 계약 테스트",
  lede_ko: "한 줄 요약.",
  body_html:
    '<p>본문 <script>alert(1)</script><img src=x onerror=alert(1)>' +
    '<a href="javascript:alert(1)">js</a> <a href="https://example.com" title="t">ext</a></p>',
  published_at: "2026-09-19T12:00:00+09:00",
  updated_at: "2026-09-19T12:00:00+09:00",
  story_id: 11,
  sources: [
    {
      name: "Example",
      url: "https://example.com",
      role: "primary",
      comments: [{ author: "u1", text: "좋다" }],
    },
  ],
};

type Stored = {
  body_html: string;
  search_text: string;
  title_ko: string;
  sources_json: string;
};

function stored(slug: string): Stored | undefined {
  return query<Stored>(
    "SELECT body_html, search_text, title_ko, sources_json FROM articles WHERE slug = ?",
    [slug],
  )[0];
}

/** 저장 순서(rowid)대로 읽는다. */
function tagsOf(slug: string): string[] {
  return query<{ tag: string }>(
    "SELECT tag FROM article_tags WHERE slug = ? ORDER BY rowid",
    [slug],
  ).map((row) => row.tag);
}

describe("POST /internal/articles", () => {
  it("Bearer 키가 없으면 401", async () => {
    const res = await postInternal(payload);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("키가 틀리면 401", async () => {
    expect((await postInternal(payload, "wrong-key")).status).toBe(401);
  });

  it("키가 맞으면 201, 재발행은 200 + 계약 형태 유지", async () => {
    const first = await postInternal(payload, API_KEY);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, slug: "ingest-brief" });

    const again = await postInternal({ ...payload, title_ko: "발행 계약 테스트 2" }, API_KEY);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, slug: "ingest-brief" });
    expect(stored("ingest-brief")?.title_ko).toBe("발행 계약 테스트 2");
  });

  it("필수 필드가 없으면 400", async () => {
    const res = await postInternal({ slug: "no-title" }, API_KEY);
    expect(res.status).toBe(400);
  });

  it("body_html을 정화한다", async () => {
    const body = stored("ingest-brief")?.body_html ?? "";
    expect(body).not.toContain("<script");
    expect(body).not.toContain("onerror");
    expect(body).not.toContain("javascript:");
    expect(body).toContain('href="https://example.com"');
    expect(body).toContain('target="_blank"');
    expect(body).toContain('rel="noopener noreferrer"');
    expect(stored("ingest-brief")?.search_text.length).toBeGreaterThan(0);
    expect(stored("ingest-brief")?.search_text).not.toContain("<");
  });

  it("search_text로 검색이 된다", async () => {
    const res = await app.request("/search?q=본문");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("발행 계약 테스트");
  });

  it("출처/커뮤니티 인용을 저장한다", async () => {
    const json = stored("ingest-brief")?.sources_json ?? "[]";
    expect(json).toContain("Example");
    expect(json).toContain("좋다");
  });

  it("잘못된 JSON은 400", async () => {
    const res = await app.request("/internal/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("tags 배열을 정규화해 저장한다", async () => {
    const res = await postInternal(
      {
        ...payload,
        slug: "ingest-tags",
        tags: ["#닌텐도", "닌텐도", "a", "TGS2026", "  스위치  ", "여섯번째", "일곱번째"],
      },
      API_KEY,
    );
    expect(res.status).toBe(201);
    expect(tagsOf("ingest-tags")).toEqual([
      "닌텐도",
      "TGS2026",
      "스위치",
      "여섯번째",
      "일곱번째",
    ]);
  });

  it("tags 키가 없으면 기존 태그를 유지한다", async () => {
    const before = tagsOf("ingest-tags");
    const res = await postInternal(
      { ...payload, slug: "ingest-tags", title_ko: "태그 유지" },
      API_KEY,
    );
    expect(res.status).toBe(200);
    expect(tagsOf("ingest-tags")).toEqual(before);
  });

  it("tags: []는 태그를 비운다", async () => {
    const res = await postInternal({ ...payload, slug: "ingest-tags", tags: [] }, API_KEY);
    expect(res.status).toBe(200);
    expect(tagsOf("ingest-tags")).toEqual([]);
  });

  it("배열이 아닌 tags는 400", async () => {
    for (const bad of ["닌텐도", 5, null, { tag: "닌텐도" }]) {
      const res = await postInternal({ ...payload, slug: "ingest-bad", tags: bad }, API_KEY);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "tags must be an array" });
    }
    expect(stored("ingest-bad")).toBeUndefined();
  });

  it("레거시 section은 태그 1개로 변환한다", async () => {
    const created = await postInternal(
      { ...payload, slug: "ingest-legacy", section: "ship" },
      API_KEY,
    );
    expect(created.status).toBe(201);
    expect(tagsOf("ingest-legacy")).toEqual(["출시·패치"]);

    // 기존 태그가 있어도 레거시 section이 오면 그 태그로 교체된다.
    await postInternal({ ...payload, slug: "ingest-legacy", tags: ["닌텐도"] }, API_KEY);
    expect(tagsOf("ingest-legacy")).toEqual(["닌텐도"]);
    await postInternal({ ...payload, slug: "ingest-legacy", section: "announce" }, API_KEY);
    expect(tagsOf("ingest-legacy")).toEqual(["발표·신작"]);
  });

  it("매핑에 없는 section은 무시한다", async () => {
    const res = await postInternal(
      { ...payload, slug: "ingest-legacy-unknown", section: "테크" },
      API_KEY,
    );
    expect(res.status).toBe(201);
    expect(tagsOf("ingest-legacy-unknown")).toEqual([]);
  });

  it("DELETE /internal/comments/:id는 운영 삭제용", async () => {
    const res = await app.request("/internal/comments/999999", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
    const unauthorized = await app.request("/internal/comments/1", { method: "DELETE" });
    expect(unauthorized.status).toBe(401);
  });
});
