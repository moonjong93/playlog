import { html } from "hono/html";
import type { TagStat } from "../tagStore.ts";
import { TAGS_PAGE_SIZE } from "../tags.ts";
import { pagination } from "./feed.ts";
import { formatRelativeTime, formatTime, layout } from "./layout.ts";

function tagsHref(page: number): string {
  return page > 1 ? `/tags?page=${page}` : "/tags";
}

/** 전체 태그 목록: 사용 횟수순, 페이지당 30개. */
export function tagsPage(options: {
  tags: TagStat[];
  page: number;
  total: number;
  activeTag: string;
  origin?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(options.total / TAGS_PAGE_SIZE));
  const rowCls =
    "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 bg-surface-container-low border border-outline-variant rounded hover:border-primary/60 transition-colors";
  const activeRowCls =
    "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 bg-surface-variant border border-primary/60 rounded";
  const empty = html`<div
    class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
  >
    아직 태그가 없습니다.
  </div>`;

  const list = html`<ul class="flex flex-col gap-2">
    ${options.tags.map(
    (row) => html`<li>
        <a
          class="${row.tag === options.activeTag ? activeRowCls : rowCls}"
          href="/?tag=${encodeURIComponent(row.tag)}"
        >
          <span
            class="px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm bg-surface-container text-primary ${row.tag ===
      options.activeTag
      ? "font-semibold"
      : ""}"
            >#${row.tag}</span
          >
          <span class="text-label-mono-sm font-label-mono-sm text-outline"
            >${row.count}건 ·
            <time datetime="${row.last_published_at}" title="${formatTime(row.last_published_at)}"
              >${formatRelativeTime(row.last_published_at)}</time
            ></span
          >
        </a>
      </li>`,
  )}
  </ul>`;

  return layout({
    title: "태그 · Ludus Digest",
    description: `Ludus Digest에 쌓인 태그 ${options.total}개. 태그를 고르면 해당 주제의 게임 업계 뉴스만 모아 봅니다.`,
    current: "tags",
    activeTag: options.activeTag,
    canonical: tagsHref(options.page),
    origin: options.origin,
    prevPath: options.page > 1 ? tagsHref(options.page - 1) : undefined,
    nextPath: options.page < totalPages ? tagsHref(options.page + 1) : undefined,
    body: html`<div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1
          class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight"
        >
          태그
        </h1>
        <span class="text-label-mono-sm font-label-mono-sm text-outline"
          >${options.total}개</span
        >
      </div>
      ${options.tags.length === 0 ? empty : list}
      ${pagination(options.page, totalPages, tagsHref)}
    </div>`,
  });
}
