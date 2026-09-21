import { html, raw } from "hono/html";
import { NOINDEX, SITE_NAME } from "../site.ts";
import {
  formatRelativeTime,
  formatTime,
  layout,
  tagChips,
  type ArticleRow,
  type Html,
} from "./layout.ts";

export const QUERY_MAX = 100;
export const QUERY_MIN = 2;

export type SearchHit = ArticleRow & { rank: number; search_text: string };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** escape 후 매치 구간에만 <mark>를 넣는다. */
function highlight(text: string, query: string): Html {
  const escaped = escapeHtml(text);
  const needle = escapeHtml(query);
  if (!needle) return raw(escaped);
  const haystack = escaped.toLowerCase();
  const lower = needle.toLowerCase();
  let out = "";
  let from = 0;
  let at = haystack.indexOf(lower, from);
  while (at !== -1) {
    out += `${escaped.slice(from, at)}<mark>${escaped.slice(at, at + needle.length)}</mark>`;
    from = at + needle.length;
    at = haystack.indexOf(lower, from);
  }
  out += escaped.slice(from);
  return raw(out);
}

/** 매치 앞뒤 60자 스니펫. 매치 부분에만 <mark>를 넣는다. */
export function snippet(text: string, query: string, around = 60): Html | null {
  const source = (text || "").replace(/\s+/g, " ").trim();
  if (!source) return null;
  const escaped = escapeHtml(source);
  const needle = escapeHtml(query);
  const at = needle ? escaped.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at === -1) {
    const head = escaped.slice(0, around * 2);
    return raw(head + (escaped.length > around * 2 ? "…" : ""));
  }
  const start = Math.max(0, at - around);
  const end = Math.min(escaped.length, at + needle.length + around);
  const before = start > 0 ? "…" : "";
  const after = end < escaped.length ? "…" : "";
  const marked =
    escaped.slice(start, at) +
    "<mark>" +
    escaped.slice(at, at + needle.length) +
    "</mark>" +
    escaped.slice(at + needle.length, end);
  return raw(`${before}${marked}${after}`);
}

function resultItem(hit: SearchHit, query: string) {
  const href = `/s/${encodeURIComponent(hit.slug)}`;
  const body = snippet(hit.search_text || hit.body_html, query);
  return html`<article
    class="feed-card bg-surface-container-low border border-outline-variant rounded p-4 hover:border-primary/60 transition-all duration-150"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2 mb-1.5">
        <time
          class="text-label-mono-sm font-label-mono-sm text-outline"
          datetime="${hit.published_at}"
          title="${formatTime(hit.published_at)}"
          >${formatRelativeTime(hit.published_at)}</time
        >
      </div>
      <h2
        class="text-headline-sm font-headline-sm font-semibold text-on-surface leading-snug"
      >
        <a
          href="${href}"
          class="text-on-surface no-underline hover:text-primary transition-colors"
          >${highlight(hit.title_ko, query)}</a
        >
      </h2>
      ${tagChips(hit.tags ?? [])}
      ${body
      ? html`<p class="mt-2 text-body-sm font-body-sm text-on-surface-variant">
          ${body}
        </p>`
      : ""}
    </div>
  </article>`;
}

function searchHref(q: string, tag: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

/** /search 결과 파셜(#search-results 내부). */
export function searchResults(options: {
  hits: SearchHit[];
  q: string;
  tag: string;
  notice?: string;
}) {
  const { hits, q, tag } = options;
  const activeTag = tag
    ? html`<a
        class="px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm bg-surface-variant text-primary font-semibold"
        href="${searchHref(q, "")}"
        title="태그 필터 해제"
        >#${tag} ✕</a
      >`
    : "";

  const notice = options.notice
    ? html`<div
        class="p-4 bg-surface-container-low border border-outline-variant rounded text-body-md font-body-md text-on-surface-variant"
      >
        ${options.notice}
      </div>`
    : "";

  const empty = html`<div
    class="p-6 bg-surface-container-low border border-outline-variant rounded text-body-md font-body-md text-on-surface-variant"
  >
    검색 결과가 없습니다.
  </div>`;

  return html`<div class="flex flex-col gap-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-1.5">${activeTag}</div>
      ${q ? html`<span class="text-label-mono-sm font-label-mono-sm text-outline">${hits.length}건</span>` : ""}
    </div>
    ${notice}
    ${q && !options.notice
      ? hits.length === 0
        ? empty
        : html`<div class="flex flex-col gap-3">
            ${hits.map((hit) => resultItem(hit, q))}
          </div>`
      : ""}
  </div>`;
}

export function searchPage(options: {
  hits: SearchHit[];
  q: string;
  tag: string;
  notice?: string;
  origin?: string;
}) {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.tag) params.set("tag", options.tag);
  const query = params.toString();

  return layout({
    title: options.q ? `${options.q} 검색 · ${SITE_NAME}` : `검색 · ${SITE_NAME}`,
    description: `${SITE_NAME} 기사 검색. 제목·요약·본문에서 키워드로 게임 업계 뉴스를 찾습니다.`,
    current: "search",
    activeTag: options.tag,
    q: options.q,
    origin: options.origin,
    // 검색 결과는 색인하지 않는다(중복·얇은 페이지).
    robots: NOINDEX,
    canonical: query ? `/search?${query}` : "/search",
    body: html`<div class="flex flex-col gap-5">
      <h1
        class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight"
      >
        검색
      </h1>
      <div id="search-results">${searchResults(options)}</div>
    </div>`,
  });
}
