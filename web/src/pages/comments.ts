import { html } from "hono/html";
import { formatRelativeTime, formatTime } from "./layout.ts";

export const NICKNAME_MAX = 20;
export const BODY_MIN = 2;
export const BODY_MAX = 1000;
export const COMMENT_PAGE_SIZE = 50;

/** honeypot. 채워지면 조용히 무시한다. */
export const HONEYPOT_FIELD = "website";

export type CommentRow = {
  id: number;
  nickname: string;
  body: string;
  session_id: string;
  created_at: string;
};

export function commentItem(comment: CommentRow, sessionId: string) {
  const mine = comment.session_id === sessionId;
  return html`<li
    id="comment-${comment.id}"
    class="bg-surface-container-low border border-outline-variant rounded p-3.5"
  >
    <div class="flex items-center justify-between gap-3 mb-1.5">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-label-ui font-label-ui font-semibold text-on-surface"
          >${comment.nickname}</span
        >
        <time
          class="text-label-mono-sm font-label-mono-sm text-outline"
          datetime="${comment.created_at}"
          title="${formatTime(comment.created_at)}"
          >${formatRelativeTime(comment.created_at)}</time
        >
      </div>
      ${mine
      ? html`<form
            action="/comments/${comment.id}/delete"
            method="post"
            hx-action="/comments/${comment.id}/delete"
            hx-method="post"
            hx-target="closest li"
            hx-swap="outerHTML"
          >
            <button
              type="submit"
              class="text-label-ui font-label-ui text-outline hover:text-error transition-colors"
              aria-label="댓글 삭제"
            >
              삭제
            </button>
          </form>`
      : ""}
    </div>
    <p
      class="text-body-sm font-body-sm text-on-surface-variant whitespace-pre-wrap break-words"
    >
      ${comment.body}
    </p>
  </li>`;
}

/** 삭제 직후 자리에 남는 표시. 새로고침하면 목록에서 사라진다. */
export function commentTombstone(id: number) {
  return html`<li
    id="comment-${id}"
    class="bg-surface-container-low border border-outline-variant rounded p-3.5 text-body-sm font-body-sm text-outline"
  >
    삭제된 댓글입니다.
  </li>`;
}

export function commentCount(count: number) {
  return html`<hx-partial id="comment-count">${count}</hx-partial>`;
}

/** 삭제/추가 후 빈 목록 안내를 지운다. */
export function commentEmptyClear() {
  return html`<hx-partial id="comment-empty" hx-swap="outerHTML"
    ><div
      id="comment-empty"
      class="mt-4 text-body-sm font-body-sm text-on-surface-variant"
    ></div
  ></hx-partial>`;
}

/** 검증 실패/거부 안내. 메인 타깃은 건드리지 않는다. */
export function commentError(message: string) {
  return html`<hx-partial id="comment-form-error"
    ><div
      class="p-2.5 bg-surface-container border border-outline-variant border-l-2 border-l-error rounded text-body-sm font-body-sm text-error"
    >
      ${message}
    </div></hx-partial
  >`;
}

/** 등록 성공 시 이전 오류 안내를 지운다. */
export function commentErrorClear() {
  return html`<hx-partial id="comment-form-error"></hx-partial>`;
}

export function commentForm(slug: string) {
  const field =
    "w-full bg-surface-container text-body-sm font-body-sm text-on-surface placeholder:text-outline border border-outline-variant rounded px-3 py-2 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all";
  return html`<form
    id="comment-form"
    class="mt-4"
    action="/s/${slug}/comments"
    method="post"
    hx-action="/s/${slug}/comments"
    hx-method="post"
    hx-target="#comment-list"
    hx-swap="afterbegin"
    hx-on="commentPosted from:body -> this.reset()"
  >
    <div id="comment-form-error" class="mb-2"></div>
    <div class="hidden" aria-hidden="true">
      <label for="comment-website">웹사이트</label>
      <input id="comment-website" type="text" name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off" />
    </div>
    <div class="flex flex-col gap-2">
      <div class="flex flex-col gap-1">
        <label
          for="comment-nickname"
          class="text-label-ui font-label-ui text-on-surface-variant"
          >닉네임 (선택, 최대 ${NICKNAME_MAX}자)</label
        >
        <input
          id="comment-nickname"
          class="${field} max-w-60"
          type="text"
          name="nickname"
          maxlength="${NICKNAME_MAX}"
          autocomplete="off"
          placeholder="익명"
        />
      </div>
      <div class="flex flex-col gap-1">
        <label for="comment-body" class="text-label-ui font-label-ui text-on-surface-variant"
          >내용 (${BODY_MIN}~${BODY_MAX}자)</label
        >
        <textarea
          id="comment-body"
          class="${field} min-h-20 resize-y"
          name="body"
          rows="3"
          minlength="${BODY_MIN}"
          maxlength="${BODY_MAX}"
          required
        ></textarea>
      </div>
      <div class="flex justify-end">
        <button
          type="submit"
          class="px-3 py-1.5 rounded bg-surface-variant text-primary border border-primary/60 text-label-ui font-label-ui font-semibold hover:bg-surface-container-highest transition-colors"
        >
          댓글 등록
        </button>
      </div>
    </div>
  </form>`;
}

export function commentSection(options: {
  slug: string;
  comments: CommentRow[];
  count: number;
  sessionId: string;
  notice?: string;
}) {
  return html`<section
    id="comments"
    class="mt-12 border-t border-outline-variant pt-6"
    aria-labelledby="comments-title"
  >
    <h2
      id="comments-title"
      class="text-label-ui font-label-ui font-semibold tracking-wider text-primary"
    >
      댓글 <span id="comment-count">${options.count}</span>
    </h2>
    ${options.notice
      ? html`<div
          class="mt-3 p-2.5 bg-surface-container border border-outline-variant border-l-2 border-l-outline rounded text-body-sm font-body-sm text-on-surface-variant"
        >
          ${options.notice}
        </div>`
      : ""}
    ${commentForm(options.slug)}
    <div
      id="comment-empty"
      class="mt-4 text-body-sm font-body-sm text-on-surface-variant"
    >
      ${options.comments.length === 0 ? "아직 댓글이 없습니다. 첫 댓글을 남겨보세요." : ""}
    </div>
    <ul id="comment-list" class="flex flex-col gap-2.5">
      ${options.comments.map((comment) => commentItem(comment, options.sessionId))}
    </ul>
  </section>`;
}
