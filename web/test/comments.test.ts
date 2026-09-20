import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  app,
  cleanup,
  hashIp,
  insertArticle,
  newSessionCookie,
  postComment,
  postForm,
  query,
  run,
  setRateLimitDisabled,
} from "./helpers.ts";

const SLUG = "comment-target";

beforeAll(() => {
  insertArticle({ slug: SLUG, title: "댓글 대상 기사", section: "announce" });
});

beforeEach(() => {
  setRateLimitDisabled(true);
});

afterAll(() => cleanup());

function commentRows(): { id: number; body: string }[] {
  return query<{ id: number; body: string }>(
    "SELECT id, body FROM comments WHERE slug = ? AND deleted_at IS NULL",
    [SLUG],
  );
}

describe("댓글", () => {
  it("등록 → 목록/개수에 반영된다", async () => {
    const cookie = await newSessionCookie();
    const res = await postComment({ slug: SLUG, body: "첫 댓글입니다", cookie });
    expect(res.status).toBe(201);
    expect(res.headers.get("HX-Trigger")).toBe("commentPosted");
    const fragment = await res.text();
    expect(fragment).toContain("첫 댓글입니다");
    expect(fragment).toContain("익명");
    expect(fragment).toContain('<hx-partial id="comment-count">1</hx-partial>');
    // 빈 목록 안내를 지우는 파셜
    expect(fragment).toContain('<hx-partial id="comment-empty"');
    // 이전 오류 안내를 지우는 파셜
    expect(fragment).toContain('<hx-partial id="comment-form-error"></hx-partial>');

    const page = await (await app.request(`/s/${SLUG}`)).text();
    expect(page).toContain("첫 댓글입니다");
    expect(page).toContain("comment-list");
    // htmx 계약: 폼은 afterbegin으로 목록에 붙이고, 성공 이벤트(HX-Trigger)로만 비운다.
    expect(page).toContain('hx-target="#comment-list"');
    expect(page).toContain('hx-swap="afterbegin"');
    expect(page).toContain('hx-on="commentPosted from:body -> this.reset()"');
    expect(page).toContain('action="/s/comment-target/comments"');
    expect(page).toContain('method="post"');
    expect(commentRows().length).toBe(1);
  });

  it("닉네임을 넣으면 그대로 표시된다", async () => {
    const cookie = await newSessionCookie();
    const res = await postComment({
      slug: SLUG,
      body: "닉네임 댓글",
      nickname: "루두스",
      cookie,
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toContain("루두스");
  });

  it("내용 길이 검증은 422 + 에러 HTML", async () => {
    const cookie = await newSessionCookie();
    const res = await postComment({ slug: SLUG, body: "x", cookie });
    expect(res.status).toBe(422);
    const fragment = await res.text();
    expect(fragment).toContain("내용은 2자 이상 1000자 이하");
    expect(fragment).toContain('id="comment-form-error"');
    expect(fragment).not.toContain('class="feed-card');

    const tooLong = await postComment({ slug: SLUG, body: "가".repeat(1001), cookie });
    expect(tooLong.status).toBe(422);
  });

  it("닉네임 21자는 422", async () => {
    const cookie = await newSessionCookie();
    const res = await postComment({
      slug: SLUG,
      body: "닉네임 검증",
      nickname: "가".repeat(21),
      cookie,
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("닉네임은 20자 이하");
  });

  it("일반 폼은 303, 검증 실패는 400", async () => {
    const cookie = await newSessionCookie();
    const ok = await postComment({ slug: SLUG, body: "일반 폼 댓글", cookie, partial: false });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/s/${SLUG}#comments`);

    const bad = await postComment({ slug: SLUG, body: "x", cookie, partial: false });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("내용은 2자 이상");
  });

  it("honeypot이 채워지면 조용히 무시한다", async () => {
    const before = commentRows().length;
    const cookie = await newSessionCookie();
    const res = await postComment({
      slug: SLUG,
      body: "봇 댓글",
      cookie,
      honeypot: "http://spam.example",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("봇 댓글");
    expect(commentRows().length).toBe(before);
  });

  it("Origin이 다르면 403", async () => {
    const cookie = await newSessionCookie();
    const res = await postComment({
      slug: SLUG,
      body: "남의 사이트 요청",
      cookie,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("다른 사이트");
  });

  it("본인 댓글만 삭제할 수 있다", async () => {
    const owner = await newSessionCookie();
    const other = await newSessionCookie();
    const created = await postComment({ slug: SLUG, body: "삭제될 댓글", cookie: owner });
    expect(created.status).toBe(201);
    const id = Number((await created.text()).match(/id="comment-(\d+)"/)?.[1]);
    expect(Number.isInteger(id)).toBe(true);

    const denied = await postForm(`/comments/${id}/delete`, {}, { cookie: other });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("본인 댓글만 삭제");

    // htmx 계약: 삭제 폼은 closest li를 outerHTML로 교체한다.
    const ownerPage = await (
      await app.request(`/s/${SLUG}`, { headers: { Cookie: `sid=${owner}` } })
    ).text();
    expect(ownerPage).toContain('hx-target="closest li"');
    expect(ownerPage).toContain('hx-swap="outerHTML"');
    expect(ownerPage).toContain(`action="/comments/${id}/delete"`);

    const ok = await postForm(`/comments/${id}/delete`, {}, { cookie: owner });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("삭제된 댓글입니다");
    expect(commentRows().some((row) => row.id === id)).toBe(false);
    expect(await (await app.request(`/s/${SLUG}`)).text()).not.toContain("삭제될 댓글");
  });

  it("운영 삭제는 Bearer가 필요하다", async () => {
    const cookie = await newSessionCookie();
    const created = await postComment({ slug: SLUG, body: "운영 삭제 대상", cookie });
    const id = Number((await created.text()).match(/id="comment-(\d+)"/)?.[1]);

    const denied = await app.request(`/internal/comments/${id}`, { method: "DELETE" });
    expect(denied.status).toBe(401);

    const ok = await app.request(`/internal/comments/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.WEB_API_KEY}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, id });
    expect(commentRows().some((row) => row.id === id)).toBe(false);
  });

  it("같은 세션은 30초에 하나만 쓴다(429 + Retry-After)", async () => {
    setRateLimitDisabled(false);
    const cookie = await newSessionCookie();
    const first = await postComment({ slug: SLUG, body: "쿨다운 첫 댓글", cookie });
    expect(first.status).toBe(201);
    const second = await postComment({ slug: SLUG, body: "쿨다운 두번째", cookie });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    // 실패 응답에는 폼 리셋 이벤트를 보내지 않는다(입력 보존).
    expect(second.headers.get("HX-Trigger")).toBeNull();
    expect(await second.text()).toContain("댓글은 30초에 하나만");
  });

  it("IP당 1시간 10개를 넘으면 429", async () => {
    setRateLimitDisabled(false);
    const ip_hash = hashIp("unknown");
    for (let i = 0; i < 10; i += 1) {
      run(
        `INSERT INTO comments (slug, nickname, body, session_id, ip_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [SLUG, "익명", `누적 댓글 ${i}`, `seed-session-${i}`, ip_hash, new Date().toISOString()],
      );
    }
    const cookie = await newSessionCookie();
    const res = await postComment({ slug: SLUG, body: "이건 막혀야 한다", cookie });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("댓글은 30초에 하나만");
  });
});
