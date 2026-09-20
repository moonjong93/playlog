import { html } from "hono/html";
import { SECTIONS, SECTION_LABELS, sectionLabel } from "../sections.ts";
import {
  formatRelativeTime,
  formatTime,
  layout,
  sectionTag,
  sourceBadges,
  summaryBox,
  type ArticleRow,
} from "./layout.ts";

export const PAGE_SIZE = 20;

function feedCard(article: ArticleRow) {
  const href = `/s/${encodeURIComponent(article.slug)}`;
  return html`<article
    class="feed-card bg-surface-container-low border border-outline-variant rounded p-4 hover:border-primary/60 transition-all duration-150"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2 mb-1.5">
        ${sourceBadges(article.sources_json)}
        <time
          class="text-label-mono-sm font-label-mono-sm text-outline"
          datetime="${article.published_at}"
          title="${formatTime(article.published_at)}"
          >${formatRelativeTime(article.published_at)}</time
        >
      </div>
      <h2
        class="text-headline-sm font-headline-sm font-semibold text-on-surface leading-snug"
      >
        <a
          href="${href}"
          class="text-on-surface no-underline hover:text-primary transition-colors"
          >${article.title_ko}</a
        >
      </h2>
      ${sectionTag(article.section)} ${summaryBox(article.lede_ko)}
    </div>
  </article>`;
}

/** 전체 + 5개 섹션 탭. hrefFor로 피드/검색 URL을 만든다. */
export function sectionTabs(active: string, hrefFor: (section: string) => string) {
  const base =
    "px-3 py-1.5 rounded text-label-ui font-label-ui border transition-colors";
  const on = "bg-surface-variant text-primary border-primary/60 font-semibold";
  const off =
    "bg-surface-container text-on-surface-variant border-outline-variant hover:text-on-surface";
  const tab = (section: string, label: string) =>
    html`<a class="${base} ${section === active ? on : off}" href="${hrefFor(section)}"
      >${label}</a
    >`;
  return html`<nav class="flex flex-wrap items-center gap-1.5" aria-label="섹션 필터">
    ${tab("", "전체")}
    ${SECTIONS.map((section) => tab(section, SECTION_LABELS[section]))}
  </nav>`;
}

function pageHref(section: string, page: number): string {
  const params = new URLSearchParams();
  if (section) params.set("section", section);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function pagination(section: string, page: number, totalPages: number) {
  if (totalPages <= 1) return "";
  const linkCls =
    "px-3 py-1.5 rounded border border-outline-variant bg-surface-container text-body-sm font-body-sm text-on-surface-variant hover:text-on-surface transition-colors";
  const currentCls =
    "px-3 py-1.5 rounded border border-primary/60 bg-surface-variant text-body-sm font-body-sm text-primary font-semibold";
  const disabledCls =
    "px-3 py-1.5 rounded border border-outline-variant bg-surface-container text-body-sm font-body-sm text-outline";

  const first = Math.max(1, page - 2);
  const last = Math.min(totalPages, page + 2);
  const numbers: number[] = [];
  for (let n = first; n <= last; n += 1) numbers.push(n);

  return html`<nav
    class="mt-8 flex flex-wrap items-center justify-center gap-2"
    aria-label="페이지"
  >
    ${page > 1
      ? html`<a class="${linkCls}" href="${pageHref(section, page - 1)}">이전</a>`
      : html`<span class="${disabledCls}">이전</span>`}
    ${numbers.map((n) =>
    n === page
      ? html`<span class="${currentCls}" aria-current="page">${n}</span>`
      : html`<a class="${linkCls}" href="${pageHref(section, n)}">${n}</a>`,
  )}
    ${page < totalPages
      ? html`<a class="${linkCls}" href="${pageHref(section, page + 1)}">다음</a>`
      : html`<span class="${disabledCls}">다음</span>`}
  </nav>`;
}

export function feedPage(options: {
  articles: ArticleRow[];
  section: string;
  page: number;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(options.total / PAGE_SIZE));
  const empty = html`<div
    class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
  >
    아직 기사가 없습니다.
  </div>`;
  const list = html`<div class="flex flex-col gap-3">
    ${options.articles.map((article) => feedCard(article))}
  </div>`;

  const title = options.section
    ? `${sectionLabel(options.section) ?? options.section} · Ludus Digest`
    : "Ludus Digest";

  return layout({
    title,
    current: "feed",
    section: options.section,
    canonical: options.section ? `/?section=${options.section}` : "/",
    ogType: "website",
    body: html`<div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        ${sectionTabs(options.section, (section) => (section ? `/?section=${section}` : "/"))}
        <span class="text-label-mono-sm font-label-mono-sm text-outline"
          >${options.total}건</span
        >
      </div>
      ${options.articles.length === 0 ? empty : list}
      ${pagination(options.section, options.page, totalPages)}
    </div>`,
  });
}
