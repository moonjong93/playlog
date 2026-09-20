import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { html, raw } from "hono/html";

const FALLBACK_CSS = `body{background:#0f131d;color:#dfe2f1;font-family:Inter,sans-serif;margin:0}`;

function loadCss(): string {
  try {
    return readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../dist/app.css"),
      "utf8",
    );
  } catch {
    return FALLBACK_CSS;
  }
}

const appCss = loadCss();

export type ArticleRow = {
  slug: string;
  title_ko: string;
  lede_ko: string;
  body_html: string;
  section: string;
  published_at: string;
  updated_at: string;
  story_id: number | null;
  sources_json: string;
};

export type Source = {
  name?: string;
  url?: string;
  role?: string;
  comments?: { author?: string; text?: string }[];
};

export function parseSources(json: string): Source[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as Source[]) : [];
  } catch {
    return [];
  }
}

export function withKey(path: string, key?: string): string {
  if (!key) return path;
  return `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  if (diff < 0) return formatTime(iso);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return formatTime(iso);
}

function sourceLabel(source: Source): string {
  const name = source.name?.trim();
  if (name) return name;
  if (source.url) {
    try {
      return new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      return source.url;
    }
  }
  return "출처";
}

function articleSources(json: string): Source[] {
  return parseSources(json).filter((source) => source.url || source.name);
}

type SourceGroup = { label: string; items: Source[] };

function groupSources(json: string): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const index = new Map<string, number>();
  for (const source of articleSources(json)) {
    const label = sourceLabel(source);
    const key = label.toLowerCase();
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, groups.length);
      groups.push({ label, items: [source] });
    } else {
      groups[at].items.push(source);
    }
  }
  return groups;
}

function sourceBadgeLabel(group: SourceGroup): string {
  const n = group.items.length;
  return n > 1 ? `${group.label}+${n}` : group.label;
}

function sourceBadges(json: string) {
  const cls =
    "px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm bg-surface-container text-on-surface-variant border border-outline-variant";
  return groupSources(json).map((group) => {
    const label = sourceBadgeLabel(group);
    const first = group.items.find((s) => s.url);
    const title = group.items.map((s) => s.url || sourceLabel(s)).join("\n");
    return first?.url
      ? html`<a
          href="${first.url}"
          class="${cls} hover:text-primary"
          rel="noopener noreferrer"
          title="${title}"
          >${label}</a
        >`
      : html`<span class="${cls}">${label}</span>`;
  });
}

function communityQuotes(json: string): { author: string; text: string }[] {
  const out: { author: string; text: string }[] = [];
  for (const source of articleSources(json)) {
    for (const row of source.comments || []) {
      const text = row.text?.trim();
      if (!text) continue;
      out.push({ author: row.author?.trim() || "anon", text });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function communityBox(json: string) {
  const quotes = communityQuotes(json);
  if (quotes.length === 0) return "";
  return html`<section
    class="mt-10 p-4 bg-surface-container rounded border border-outline-variant border-l-2 border-l-secondary"
  >
    <h2
      class="mb-3 text-label-ui font-label-ui font-semibold tracking-wider text-secondary"
    >
      커뮤니티 반응
    </h2>
    <ul class="space-y-2.5 text-body-sm font-body-sm text-on-surface-variant">
      ${quotes.map(
    (q) => html`<li>
          <span class="text-outline font-label-mono-sm">u/${q.author}</span>
          <p class="mt-0.5 text-on-surface-variant">${q.text}</p>
        </li>`,
  )}
    </ul>
  </section>`;
}

function sectionTag(section: string) {
  const tag = section.trim();
  if (!tag) return "";
  const label = tag.startsWith("#") ? tag : `#${tag}`;
  return html`<div class="flex flex-wrap items-center gap-1.5 mt-2">
    <span
      class="px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm bg-surface-variant text-primary font-medium"
      >${label}</span
    >
  </div>`;
}

function siteHeader(key: string | undefined, current: "feed" | "article" | "none") {
  const home = withKey("/", key);
  const feedLink =
    current === "feed"
      ? html`<a
          class="border-b-2 border-primary text-on-surface font-semibold py-3 transition-colors text-label-ui font-label-ui"
          href="${home}"
          >종합 피드</a
        >`
      : html`<a
          class="text-on-surface-variant hover:text-on-surface py-3 transition-colors text-label-ui font-label-ui"
          href="${home}"
          >종합 피드</a
        >`;

  return html`<header
    class="bg-surface-container-low border-b border-outline-variant sticky top-0 z-50"
  >
    <div class="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-6">
      <div class="flex items-center gap-8 min-w-0">
        <a class="flex items-center gap-2.5 group shrink-0" href="${home}">
          <div
            class="w-8 h-8 rounded bg-surface-container-high border border-outline-variant flex items-center justify-center text-primary group-hover:border-primary transition-colors"
          >
            <span class="material-symbols-outlined text-primary text-[20px]"
              >terminal</span
            >
          </div>
          <div class="flex flex-col">
            <span
              class="text-headline-sm font-headline-sm font-bold text-on-surface tracking-tight leading-none"
              >Ludus Digest</span
            >
            <span
              class="text-label-mono-sm font-label-mono-sm text-outline tracking-wider mt-0.5"
              >루두스 다이제스트</span
            >
          </div>
        </a>
        <nav class="hidden lg:flex items-center gap-6">
          ${feedLink}
          <span
            class="text-on-surface-variant py-3 text-label-ui font-label-ui cursor-default"
            >웹진 심층 분석</span
          >
          <span
            class="text-on-surface-variant py-3 text-label-ui font-label-ui cursor-default flex items-center gap-1.5"
            >AI 3줄 요약
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-secondary"></span
          ></span>
          <span
            class="text-on-surface-variant py-3 text-label-ui font-label-ui cursor-default"
            >특가/할인 [BETA]</span
          >
          <span
            class="text-outline py-3 text-label-ui font-label-ui cursor-default border-b border-dashed border-outline-variant"
            >커뮤니티 [준비중]</span
          >
        </nav>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <div class="relative hidden sm:block w-64 md:w-80">
          <div
            class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-outline"
          >
            <span class="material-symbols-outlined text-[18px]">search</span>
          </div>
          <input
            class="w-full h-8 pl-9 pr-14 bg-surface-container text-body-sm font-body-sm text-on-surface placeholder:text-outline border border-outline-variant rounded focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            placeholder="기사, 웹진, 스팀 덱, UE5 검색..."
            type="search"
            name="q"
            autocomplete="off"
          />
          <div
            class="absolute inset-y-0 right-0 pr-2 flex items-center pointer-events-none"
          >
            <kbd
              class="h-5 px-1.5 bg-surface-variant text-outline rounded text-label-mono-sm font-label-mono-sm border border-outline-variant flex items-center"
              >⌘K</kbd
            >
          </div>
        </div>
        <button
          aria-label="Toggle Theme"
          class="w-8 h-8 rounded border border-outline-variant bg-surface-container hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface flex items-center justify-center transition-colors duration-150 ease-in-out"
          type="button"
        >
          <span class="material-symbols-outlined text-[18px]">dark_mode</span>
        </button>
        <button
          aria-label="Notifications"
          class="relative w-8 h-8 rounded border border-outline-variant bg-surface-container hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface flex items-center justify-center transition-colors duration-150 ease-in-out"
          type="button"
        >
          <span class="material-symbols-outlined text-[18px]">notifications</span>
        </button>
        <div
          class="w-8 h-8 rounded border border-outline-variant overflow-hidden bg-surface-container flex items-center justify-center text-on-surface-variant"
        >
          <span class="material-symbols-outlined text-[18px]">person</span>
        </div>
      </div>
    </div>
  </header>`;
}

function siteFooter() {
  return html`<footer
    class="bg-surface-container-lowest border-t border-outline-variant mt-12"
  >
    <div
      class="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row justify-between items-center gap-4"
    >
      <div class="flex flex-col md:flex-row items-center gap-4">
        <span class="text-label-mono-md font-label-mono-md font-bold text-on-surface"
          >Ludus Digest</span
        >
        <span class="text-body-sm font-body-sm text-outline text-center md:text-left">
          High-density intelligence for the gaming industry. Powered by AI Summaries.
        </span>
      </div>
    </div>
  </footer>`;
}

function layout(
  title: string,
  key: string | undefined,
  body: ReturnType<typeof html>,
  current: "feed" | "article" | "none" = "none",
) {
  return html`<!DOCTYPE html>
    <html class="dark" lang="ko">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
          rel="stylesheet"
        />
        <style>
          ${raw(appCss)}
        </style>
      </head>
      <body
        class="bg-surface text-on-surface font-body-md antialiased min-h-screen flex flex-col selection:bg-primary selection:text-on-primary"
      >
        ${siteHeader(key, current)}
        <main class="max-w-7xl mx-auto px-6 py-6 w-full flex-grow">
          <div class="max-w-4xl">${body}</div>
        </main>
        ${siteFooter()}
      </body>
    </html>`;
}

function summaryLines(lede: string): string[] {
  const rawLede = (lede || "").trim();
  if (!rawLede) return [];
  const byNl = rawLede
    .split(/\n+/)
    .map((s) => s.replace(/^[•*\-\d.\s]+/, "").trim())
    .filter(Boolean);
  if (byNl.length >= 2) return byNl.slice(0, 5);
  return rawLede
    .split(/(?<=다)\.\s+|(?<=요)\.\s+|\.\s+/)
    .map((s) => s.replace(/^[•*\-\d.\s]+/, "").trim())
    .filter((s) => s.length > 8)
    .slice(0, 5);
}

function summaryBox(lede: string) {
  const lines = summaryLines(lede);
  if (lines.length === 0) return "";
  return html`<div
    class="summary-box mt-3.5 p-3 bg-surface-container rounded border border-outline-variant border-l-2 border-l-primary"
  >
    <div
      class="flex items-center gap-1.5 text-label-ui font-label-ui text-primary font-semibold"
    >
    </div>
    <ul class="space-y-1.5 text-body-sm font-body-sm text-on-surface-variant">
      ${lines.map(
    (line) => html`<li class="flex items-start gap-2">
          <span class="text-primary font-bold">•</span>
          <span>${line}</span>
        </li>`,
  )}
    </ul>
  </div>`;
}



function feedCard(article: ArticleRow, key?: string) {
  const href = withKey(`/s/${encodeURIComponent(article.slug)}`, key);
  return html`<article
    class="feed-card bg-surface-container-low border border-outline-variant rounded p-4 hover:border-primary/60 transition-all duration-150"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2 mb-1.5">
        <!-- ${sourceBadges(article.sources_json)} -->
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

export function listPage(articles: ArticleRow[], key?: string) {
  const items =
    articles.length === 0
      ? html`<div
          class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
        >
          아직 기사가 없습니다.
        </div>`
      : html`<div class="flex flex-col gap-3">
          ${articles.map((article) => feedCard(article, key))}
        </div>`;

  return layout("Ludus Digest", key, items, "feed");
}

export function articlePage(article: ArticleRow, key?: string) {
  const groups = groupSources(article.sources_json);
  const sourceBlock =
    groups.length === 0
      ? ""
      : html`<aside class="mt-12 border-t border-outline-variant pt-6">
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

  return layout(
    `${article.title_ko} · Ludus Digest`,
    key,
    html`<article>
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
      ${sectionTag(article.section)} ${summaryBox(article.lede_ko)}
      <div class="article-body mt-8">
        ${raw(article.body_html)}
      </div>
      ${communityBox(article.sources_json)}
      ${sourceBlock}
    </article>`,
    "article",
  );
}

export function notFoundPage(key?: string) {
  return layout(
    "없는 기사 · Ludus Digest",
    key,
    html`<div
      class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
    >
      기사를 찾을 수 없습니다.
    </div>`,
    "none",
  );
}
