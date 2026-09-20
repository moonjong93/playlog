import { readFileSync } from "node:fs";
import { join } from "node:path";
import { html, raw } from "hono/html";
import { env, rootDir } from "../env.ts";
import { recentTags } from "../tagStore.ts";

const FALLBACK_CSS = `body{background:#0f131d;color:#dfe2f1;font-family:Inter,sans-serif;margin:0}`;

function loadCss(): string {
  try {
    return readFileSync(join(rootDir, "dist/app.css"), "utf8");
  } catch {
    return FALLBACK_CSS;
  }
}

const appCss = loadCss();

export type Html = ReturnType<typeof html>;

export type ArticleRow = {
  slug: string;
  title_ko: string;
  lede_ko: string;
  body_html: string;
  published_at: string;
  updated_at: string;
  story_id: number | null;
  sources_json: string;
  /** 태그를 붙인 조회 결과에만 채워진다(RSS 등은 비어 있음). */
  tags?: string[];
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

export function absoluteUrl(path: string): string {
  return env.siteUrl ? `${env.siteUrl}${path}` : path;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

export function formatRelativeTime(iso: string): string {
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

/** 피드 이름 꼬리표를 떼어낸 표시용 이름. `Reddit r/Games (top/day)` → `Reddit r/Games`. */
export function displaySourceName(name: string): string {
  return name.replace(/\s*\(top\/[a-z]+\)\s*$/i, "").trim() || name.trim();
}

function sourceLabel(source: Source): string {
  const name = source.name?.trim();
  if (name) return displaySourceName(name);
  if (source.url) {
    try {
      return new URL(source.url).hostname.replace(/^www\./, "");
    } catch {
      return source.url;
    }
  }
  return "출처";
}

export function articleSources(json: string): Source[] {
  return parseSources(json).filter((source) => source.url || source.name);
}

type SourceGroup = { label: string; items: Source[] };

export function groupSources(json: string): SourceGroup[] {
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

/** 출처 배지. 출처가 0건이면 아무것도 그리지 않는다. */
export function sourceBadges(json: string) {
  const cls =
    "px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm bg-surface-container text-on-surface-variant border border-outline-variant";
  const groups = groupSources(json);
  if (groups.length === 0) return "";
  return groups.map((group) => {
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

/** 태그 칩 묶음. 각 칩은 피드 태그 필터(/?tag=)로 링크한다. */
export function tagChips(tags: string[]) {
  const list = tags.filter((tag) => tag.trim() !== "");
  if (list.length === 0) return "";
  return html`<div class="flex flex-wrap items-center gap-1.5 mt-2">
    ${list.map(
    (tag) => html`<a
        class="px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm bg-surface-variant text-primary hover:font-medium"
        href="/?tag=${encodeURIComponent(tag)}"
        >#${tag}</a
      >`,
  )}
  </div>`;
}

export function summaryLines(lede: string): string[] {
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

export function summaryBox(lede: string) {
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

export type NavCurrent = "feed" | "article" | "search" | "tags" | "none";

function navLink(
  href: string,
  label: string,
  active: boolean,
  extra = "",
) {
  const cls = active
    ? "border-b-2 border-primary text-on-surface font-semibold py-3 transition-colors text-label-ui font-label-ui"
    : "text-on-surface-variant hover:text-on-surface py-3 transition-colors text-label-ui font-label-ui";
  return html`<a class="${cls} ${extra}" href="${href}">${label}</a>`;
}

function siteHeader(options: {
  current: NavCurrent;
  activeTag: string;
  q: string;
}) {
  const activeTag = options.activeTag;
  const searching = options.current === "search";
  // 검색 페이지에서만 htmx를 붙인다. 다른 페이지에는 #search-results가 없다.
  const formHx = searching
    ? ` hx-action="/search" hx-method="get" hx-target="#search-results" hx-push-url="true"`
    : "";
  const inputHx = searching
    ? ` hx-action="/search" hx-method="get" hx-trigger="input changed delay:300ms"` +
      ` hx-target="#search-results" hx-push-url="true" hx-include="closest form"`
    : "";

  return html`<header
    class="bg-surface-container-low border-b border-outline-variant sticky top-0 z-50"
  >
    <div class="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between gap-6">
      <div class="flex items-center gap-8 min-w-0">
        <a class="flex items-center gap-2.5 group shrink-0" href="/">
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
        <nav class="hidden lg:flex items-center gap-6" aria-label="태그">
          ${recentTags().map((tag) =>
    navLink(
      `/?tag=${encodeURIComponent(tag)}`,
      `#${tag}`,
      options.current === "feed" && activeTag === tag,
    ),
  )}
          ${navLink("/tags", "전체보기", options.current === "tags")}
          ${navLink("/rss.xml", "RSS", false)}
        </nav>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <form
          class="relative hidden sm:block w-64 md:w-80"
          action="/search"
          method="get"
          role="search"
          ${raw(formHx)}
        >
          <div
            class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-outline"
          >
            <span class="material-symbols-outlined text-[18px]">search</span>
          </div>
          <input
            id="site-search"
            class="w-full h-8 pl-9 pr-14 bg-surface-container text-body-sm font-body-sm text-on-surface placeholder:text-outline border border-outline-variant rounded focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            placeholder="제목·본문 검색 (2자 이상)"
            type="search"
            name="q"
            value="${options.q}"
            autocomplete="off"
            aria-label="기사 검색"
            ${raw(inputHx)}
          />
          ${activeTag
            ? html`<input type="hidden" name="tag" value="${activeTag}" />`
            : ""}
          <div
            class="absolute inset-y-0 right-0 pr-2 flex items-center pointer-events-none"
          >
            <kbd
              class="h-5 px-1.5 bg-surface-variant text-outline rounded text-label-mono-sm font-label-mono-sm border border-outline-variant flex items-center"
              >⌘K</kbd
            >
          </div>
        </form>
        <a
          href="/rss.xml"
          class="w-8 h-8 rounded border border-outline-variant bg-surface-container hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface flex items-center justify-center transition-colors duration-150 ease-in-out"
          aria-label="RSS 피드"
        >
          <span class="material-symbols-outlined text-[18px]">rss_feed</span>
        </a>
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

/** ⌘K/Ctrl+K로 검색창 포커스. htmx와 무관한 최소 인라인 스크립트. */
const SEARCH_SHORTCUT = `document.addEventListener("keydown",function(e){if(!(e.metaKey||e.ctrlKey)||e.key.toLowerCase()!=="k")return;var el=document.getElementById("site-search");if(!el)return;e.preventDefault();el.focus();});`;

export function layout(options: {
  title: string;
  body: Html;
  current?: NavCurrent;
  /** 피드에서 필터 중인 태그. 네비게이션에서 활성 표시에 쓴다. */
  activeTag?: string;
  q?: string;
  description?: string;
  canonical?: string;
  ogType?: string;
  publishedTime?: string;
}) {
  const current = options.current ?? "none";
  const activeTag = options.activeTag ?? "";
  const q = options.q ?? "";
  const description = options.description?.trim() ?? "";
  const ogType = options.ogType ?? "website";
  const canonical = options.canonical ?? "";

  return html`<!DOCTYPE html>
    <html class="dark" lang="ko">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title}</title>
        ${description ? html`<meta name="description" content="${description}" />` : ""}
        ${canonical ? html`<link rel="canonical" href="${absoluteUrl(canonical)}" />` : ""}
        <meta property="og:site_name" content="Ludus Digest" />
        <meta property="og:title" content="${options.title}" />
        ${description ? html`<meta property="og:description" content="${description}" />` : ""}
        <meta property="og:type" content="${ogType}" />
        ${canonical ? html`<meta property="og:url" content="${absoluteUrl(canonical)}" />` : ""}
        <meta property="og:locale" content="ko_KR" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="${options.title}" />
        ${description
      ? html`<meta name="twitter:description" content="${description}" />`
      : ""}
        ${options.publishedTime
      ? html`<meta property="article:published_time" content="${options.publishedTime}" />`
      : ""}
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
        <link rel="alternate" type="application/rss+xml" title="Ludus Digest" href="/rss.xml" />
        <script src="/assets/htmx.min.js" defer></script>
      </head>
      <body
        class="bg-surface text-on-surface font-body-md antialiased min-h-screen flex flex-col selection:bg-primary selection:text-on-primary"
      >
        ${siteHeader({ current, activeTag, q })}
        <main class="max-w-7xl mx-auto px-6 py-6 w-full flex-grow">
          <div class="max-w-4xl">${options.body}</div>
        </main>
        ${siteFooter()}
        <script>
          ${raw(SEARCH_SHORTCUT)}
        </script>
      </body>
    </html>`;
}
