import { html } from "hono/html";
import {
  DEAL_SORTS,
  type DealRow,
  type DealSort,
  NEW_WINDOW_MS,
} from "../deals.ts";
import { SITE_NAME } from "../site.ts";
import { formatRelativeTime, layout } from "./layout.ts";

export const MIN_DISCOUNTS = [0, 30, 50, 75] as const;

export function dealsHref(sort: DealSort, min: number): string {
  const params = new URLSearchParams();
  if (sort !== "popular") params.set("sort", sort);
  if (min > 0) params.set("min", String(min));
  const qs = params.toString();
  return qs ? `/deals?${qs}` : "/deals";
}

export function won(n: number): string {
  return n === 0 ? "무료" : `₩${n.toLocaleString("ko-KR")}`;
}

function remaining(expiresAt: string): string | null {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "1시간 이내 종료";
  if (hours < 24) return `${hours}시간 후 종료`;
  return `${Math.floor(hours / 24)}일 후 종료`;
}

function chip(label: string, href: string, active: boolean) {
  const cls = active
    ? "px-3 py-1 rounded border border-primary/60 bg-surface-variant text-on-surface font-semibold text-label-ui font-label-ui"
    : "px-3 py-1 rounded border border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-primary/60 text-label-ui font-label-ui transition-colors";
  return html`<a class="${cls}" href="${href}" ${active ? 'aria-current="true"' : ""}>${label}</a>`;
}

function dealCard(d: DealRow, showNew: boolean) {
  const isNew = showNew && Date.now() - Date.parse(d.first_seen_at) < NEW_WINDOW_MS;
  const left = d.expires_at ? remaining(d.expires_at) : null;
  const review =
    d.review_pct !== null && d.review_label
      ? `${d.review_label} · ${d.review_pct}%${d.review_count ? ` (${d.review_count.toLocaleString("ko-KR")}명)` : ""}`
      : "";
  return html`<li>
    <a
      class="deal-card flex gap-3 items-center p-2.5 bg-surface-container-low border border-outline-variant rounded hover:border-primary/60 transition-colors"
      href="https://store.steampowered.com/app/${d.app_id}/"
      target="_blank"
      rel="noopener nofollow"
    >
      ${d.image_url
        ? html`<img
            class="w-28 sm:w-40 aspect-[231/87] object-cover shrink-0 rounded"
            src="${d.image_url}"
            alt=""
            width="231"
            height="87"
            loading="lazy"
          />`
        : html`<div class="w-28 sm:w-40 aspect-[231/87] shrink-0 rounded bg-surface-container"></div>`}
      <div class="min-w-0 flex-1 flex flex-col gap-1">
        <div class="flex items-center gap-2 min-w-0">
          <span class="truncate text-body-md font-body-md font-semibold text-on-surface">${d.title}</span>
          ${isNew
            ? html`<span class="shrink-0 px-1.5 py-0.5 rounded bg-tertiary/20 text-tertiary text-label-mono-sm font-label-mono-sm">NEW</span>`
            : ""}
        </div>
        <div class="text-label-mono-sm font-label-mono-sm text-outline flex flex-wrap gap-x-3">
          ${review ? html`<span>${review}</span>` : ""}
          ${left ? html`<span class="text-tertiary">${left}</span>` : ""}
        </div>
      </div>
      <div class="shrink-0 flex items-center gap-2 text-right">
        <span class="px-2 py-1 rounded bg-primary/20 text-primary font-bold text-label-ui font-label-ui">-${d.discount_pct}%</span>
        <div class="flex flex-col leading-tight">
          <span class="text-label-mono-sm font-label-mono-sm text-outline line-through">${won(d.original_price)}</span>
          <span class="text-body-md font-body-md font-bold text-on-surface">${won(d.final_price)}</span>
        </div>
      </div>
    </a>
  </li>`;
}

export function dealsPage(options: {
  deals: DealRow[];
  sort: DealSort;
  min: number;
  updatedAt: string | null;
  newBadges: boolean;
  origin?: string;
}) {
  const { sort, min } = options;
  const sorts = (Object.keys(DEAL_SORTS) as DealSort[]).map((key) =>
    chip(DEAL_SORTS[key].label, dealsHref(key, min), key === sort),
  );
  const mins = MIN_DISCOUNTS.map((m) =>
    chip(m === 0 ? "전체" : `${m}%↑`, dealsHref(sort, m), m === min),
  );
  const empty = html`<div
    class="bg-surface-container-low border border-outline-variant rounded p-6 text-body-md font-body-md text-on-surface-variant"
  >
    ${options.updatedAt ? "조건에 맞는 할인이 없습니다." : "할인 정보를 불러오는 중입니다. 잠시 후 다시 확인해 주세요."}
  </div>`;

  return layout({
    title: `Steam 할인 소식 · ${SITE_NAME}`,
    description: "지금 Steam에서 할인 중인 인기 게임을 원화 가격과 평가, 할인율과 함께 모아 보여줍니다. 1시간마다 갱신됩니다.",
    current: "deals",
    canonical: "/deals",
    origin: options.origin,
    body: html`<div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <h1 class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight">Steam 할인 소식</h1>
        <span class="text-label-mono-sm font-label-mono-sm text-outline"
          >${options.deals.length}개${options.updatedAt
            ? html` · <time datetime="${options.updatedAt}">${formatRelativeTime(options.updatedAt)} 갱신</time>`
            : ""}</span
        >
      </div>
      <div class="flex flex-wrap gap-2" aria-label="정렬">${sorts}</div>
      <div class="flex flex-wrap gap-2" aria-label="최소 할인율">${mins}</div>
      ${options.deals.length === 0
        ? empty
        : html`<ul class="flex flex-col gap-2">${options.deals.map((d) => dealCard(d, options.newBadges))}</ul>`}
      <p class="text-label-mono-sm font-label-mono-sm text-outline">
        가격은 Steam 스토어(한국) 기준이며 수집 시점 이후 바뀔 수 있습니다. 결제 전 스토어에서 최종 가격을 확인하세요.
      </p>
    </div>`,
  });
}
