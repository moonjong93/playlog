import { html } from "hono/html";
import { layout } from "./layout.ts";

function box(message: string) {
  return html`<div
    class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
  >
    ${message}
  </div>`;
}

/** 전체 페이지 안내(404/400/403/429 등). */
export function messagePage(title: string, message: string) {
  return layout({
    title: `${title} · Ludus Digest`,
    current: "none",
    body: box(message),
  });
}

export function notFoundPage() {
  return layout({
    title: "없는 기사 · Ludus Digest",
    current: "none",
    body: box("기사를 찾을 수 없습니다."),
  });
}

export function pageNotFoundPage() {
  return layout({
    title: "없는 페이지 · Ludus Digest",
    current: "none",
    body: box("페이지를 찾을 수 없습니다."),
  });
}

/** htmx 조각용 안내. 4xx라도 스왑 대상에 맞는 HTML을 돌려준다. */
export function noticeFragment(message: string) {
  return html`<div
    class="p-3 bg-surface-container border border-outline-variant border-l-2 border-l-error rounded text-body-sm font-body-sm text-error"
  >
    ${message}
  </div>`;
}
