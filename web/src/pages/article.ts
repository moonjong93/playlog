import { html, raw } from "hono/html";
import {
  articleSources,
  formatRelativeTime,
  formatTime,
  groupSources,
  layout,
  sourceBadges,
  summaryBox,
  tagChips,
  type ArticleRow,
} from "./layout.ts";
import { commentSection, type CommentRow } from "./comments.ts";

/** 사용자 반응에 넣을 인용. 레딧 글 순서를 유지하고 최대 6개. */
function communityQuotes(json: string): { text: string }[] {
  const out: { text: string }[] = [];
  for (const source of articleSources(json)) {
    for (const row of source.comments || []) {
      const text = row.text?.trim();
      if (!text) continue;
      out.push({ text });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

/** 사용자 반응(레딧 인용). 사용자 댓글과는 별개 섹션이다. */
function communityBox(json: string) {
  const quotes = communityQuotes(json);
  if (quotes.length === 0) return "";
  return html`<section
    class="mt-10 p-4 bg-surface-container rounded border border-outline-variant border-l-2 border-l-secondary"
  >
    <h2
      class="mb-3 text-label-ui font-label-ui font-semibold tracking-wider text-secondary"
    >
      사용자 반응
    </h2>
    <ul class="space-y-1.5 text-body-sm font-body-sm text-on-surface-variant">
      ${quotes.map(
    (q) => html`<li class="flex items-start gap-2">
          <span class="text-secondary font-bold select-none">-</span>
          <span class="whitespace-pre-wrap break-words">${q.text}</span>
        </li>`,
  )}
    </ul>
  </section>`;
}

function sourceBlock(json: string) {
  const groups = groupSources(json);
  if (groups.length === 0) return "";
  return html`<aside class="mt-12 border-t border-outline-variant pt-6">
    <h2
      class="mb-3 text-label-ui font-label-ui font-semibold tracking-wider text-primary"
    >
      출처
    </h2>
    <ul class="space-y-2 text-body-sm font-body-sm">
      ${groups.map((group) => {
    const urls = group.items.filter((s) => s.url);
    const first = urls[0];
    const rest = urls.slice(1);
    if (!first?.url) {
      return html`<li class="text-on-surface-variant">${group.label}</li>`;
    }
    const badge =
      urls.length > 1
        ? html`<span class="text-outline"> +${urls.length}</span>`
        : "";
    const more =
      rest.length === 0
        ? ""
        : html`<details class="mt-1">
                  <summary
                    class="cursor-pointer text-outline hover:text-on-surface-variant"
                  >
                    나머지 ${rest.length}개
                  </summary>
                  <ul class="mt-1 ml-3 space-y-1">
                    ${rest.map(
          (source) => html`<li>
                        <a
                          href="${source.url}"
                          class="text-primary hover:underline underline-offset-4 break-all"
                          rel="noopener noreferrer"
                          >${source.url}</a
                        >
                      </li>`,
        )}
                  </ul>
                </details>`;
    return html`<li>
            <a
              href="${first.url}"
              class="text-primary hover:underline underline-offset-4"
              rel="noopener noreferrer"
              >${group.label}</a
            >${badge}${more}
          </li>`;
  })}
    </ul>
  </aside>`;
}

function ledeFirstLine(lede: string): string {
  return (lede || "").split("\n")[0]?.trim() ?? "";
}

export function articlePage(options: {
  article: ArticleRow;
  comments: CommentRow[];
  commentCount: number;
  sessionId: string;
  notice?: string;
}) {
  const article = options.article;
  const path = `/s/${encodeURIComponent(article.slug)}`;
  return layout({
    title: `${article.title_ko} · Ludus Digest`,
    description: ledeFirstLine(article.lede_ko) || article.title_ko,
    canonical: path,
    ogType: "article",
    publishedTime: article.published_at,
    current: "article",
    body: html`<article>
      <div class="flex flex-wrap items-center gap-2 mb-3">
        ${sourceBadges(article.sources_json)}
        <time
          class="text-label-mono-sm font-label-mono-sm text-outline"
          datetime="${article.published_at}"
          title="${formatTime(article.published_at)}"
          >${formatRelativeTime(article.published_at)}</time
        >
      </div>
      <h1
        class="text-headline-xl max-md:text-headline-xl-mobile font-headline-xl font-bold text-on-surface tracking-tight leading-tight"
      >
        ${article.title_ko}
      </h1>
      ${tagChips(article.tags ?? [])} ${summaryBox(article.lede_ko)}
      <div class="article-body mt-8">
        ${raw(article.body_html)}
      </div>
      ${communityBox(article.sources_json)} ${sourceBlock(article.sources_json)}
      ${commentSection({
      slug: article.slug,
      comments: options.comments,
      count: options.commentCount,
      sessionId: options.sessionId,
      notice: options.notice,
    })}
    </article>`,
  });
}
