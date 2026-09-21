import { html } from "hono/html";
import { itemListJsonLd } from "../seo.ts";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "../site.ts";
import {
  formatRelativeTime,
  formatTime,
  layout,
  sourceBadges,
  summaryBox,
  tagChips,
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
      ${tagChips(article.tags ?? [])} ${summaryBox(article.lede_ko)}
    </div>
  </article>`;
}

function feedHref(tag: string, page: number): string {
  const params = new URLSearchParams();
  if (tag) params.set("tag", tag);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/** 이전/다음 + 페이지 번호. hrefFor로 페이지별 URL을 만든다. */
export function pagination(
  page: number,
  totalPages: number,
  hrefFor: (page: number) => string,
) {
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
      ? html`<a class="${linkCls}" href="${hrefFor(page - 1)}">이전</a>`
      : html`<span class="${disabledCls}">이전</span>`}
    ${numbers.map((n) =>
    n === page
      ? html`<span class="${currentCls}" aria-current="page">${n}</span>`
      : html`<a class="${linkCls}" href="${hrefFor(n)}">${n}</a>`,
  )}
    ${page < totalPages
      ? html`<a class="${linkCls}" href="${hrefFor(page + 1)}">다음</a>`
      : html`<span class="${disabledCls}">다음</span>`}
  </nav>`;
}

export function feedPage(options: {
  articles: ArticleRow[];
  tag: string;
  page: number;
  total: number;
  origin?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(options.total / PAGE_SIZE));
  const empty = options.tag
    ? html`<div
        class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
      >
        <span class="text-primary">#${options.tag}</span> 태그의 기사가 없습니다.
        <a href="/" class="text-primary hover:underline underline-offset-4"
          >전체 기사 보기</a
        >
      </div>`
    : html`<div
        class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
      >
        아직 기사가 없습니다.
      </div>`;
  const list = html`<div class="flex flex-col gap-3">
    ${options.articles.map((article) => feedCard(article))}
  </div>`;

  const title = options.tag
    ? `#${options.tag} · ${SITE_NAME}`
    : options.page > 1
    ? `전체 기사 ${options.page}페이지 · ${SITE_NAME}`
    : `${SITE_NAME} · ${SITE_TAGLINE}`;
  const heading = options.tag ? `태그 #${options.tag}` : SITE_TAGLINE;
  const description = options.tag
    ? `#${options.tag} 태그로 모은 게임 업계 뉴스 ${options.total}건. 요약과 출처, 사용자 반응을 함께 봅니다.`
    : SITE_DESCRIPTION;
  const first = (options.page - 1) * PAGE_SIZE + 1;
  const last = first + Math.max(options.articles.length - 1, 0);
  const listLabel = options.tag
    ? `#${options.tag} 태그 기사`
    : `${SITE_NAME} 최신 기사`;
  const jsonLd =
    options.articles.length === 0 || !options.origin
      ? []
      : [
        itemListJsonLd({
          origin: options.origin,
          name: options.page > 1 ? `${listLabel} (${first}-${last})` : listLabel,
          items: options.articles.map((article) => ({
            slug: article.slug,
            title: article.title_ko,
          })),
        }),
      ];

  return layout({
    title,
    description,
    current: "feed",
    activeTag: options.tag,
    canonical: feedHref(options.tag, options.page),
    origin: options.origin,
    ogType: "website",
    jsonLd,
    prevPath: options.page > 1 ? feedHref(options.tag, options.page - 1) : undefined,
    nextPath: options.page < totalPages ? feedHref(options.tag, options.page + 1) : undefined,
    body: html`<div class="flex flex-col gap-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1
          class="text-label-ui font-label-ui text-on-surface-variant"
          >${options.tag
      ? html`태그 <span class="text-primary font-semibold">#${options.tag}</span>`
      : heading}</h1
        >
        <span class="text-label-mono-sm font-label-mono-sm text-outline"
          >${options.total}건</span
        >
      </div>
      ${options.articles.length === 0 ? empty : list}
      ${pagination(options.page, totalPages, (n) => feedHref(options.tag, n))}
    </div>`,
  });
}
