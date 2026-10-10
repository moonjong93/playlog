import { html, raw } from "hono/html";
import {
  DEAL_SORTS,
  type DealRow,
  type DealSort,
  NEW_WINDOW_MS,
  type PricePoint,
  priceHistoryUiEnabled,
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

function dealCard(d: DealRow, showNew: boolean, lowest: Map<number, number>) {
  const historyUi = priceHistoryUiEnabled();
  const isLowest = historyUi && d.final_price <= (lowest.get(d.app_id) ?? -1);
  const isNew = showNew && Date.now() - Date.parse(d.first_seen_at) < NEW_WINDOW_MS;
  const left = d.expires_at ? remaining(d.expires_at) : null;
  const review =
    d.review_pct !== null && d.review_label
      ? `${d.review_label} · ${d.review_pct}%${d.review_count ? ` (${d.review_count.toLocaleString("ko-KR")}명)` : ""}`
      : "";
  return html`<li>
    <a
      class="deal-card flex gap-3 items-center p-2.5 bg-surface-container-low border border-outline-variant rounded hover:border-primary/60 transition-colors"
      href="${historyUi ? `/deals/${d.app_id}` : `https://store.steampowered.com/app/${d.app_id}/`}"
      ${historyUi ? "" : 'target="_blank" rel="noopener nofollow"'}
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
          ${isLowest ? html`<span class="text-primary">수집 이후 최저가</span>` : ""}
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
  lowest?: Map<number, number>;
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
        : html`<ul class="flex flex-col gap-2">${options.deals.map((d) => dealCard(d, options.newBadges, options.lowest ?? new Map()))}</ul>`}
      <p class="text-label-mono-sm font-label-mono-sm text-outline">
        가격은 Steam 스토어(한국) 기준이며 수집 시점 이후 바뀔 수 있습니다. 결제 전 스토어에서 최종 가격을 확인하세요.
      </p>
    </div>`,
  });
}

/** 가격 이력을 계단형 SVG 라인으로 그린다. 점이 1개면 빈 문자열(그릴 게 없다). */
export function priceChartSvg(points: PricePoint[]): string {
  if (points.length < 2) return "";
  const W = 640, H = 220, L = 64, R = 12, T = 12, B = 28;
  const times = points.map((p) => Date.parse(p.recorded_at));
  const t0 = times[0];
  const t1 = Math.max(Date.now(), times[times.length - 1]);
  const prices = points.flatMap((p) => [p.final_price, p.original_price]);
  const max = Math.max(...prices);
  const min = Math.min(...points.map((p) => p.final_price), max);
  const lo = Math.max(0, min - (max - min) * 0.1);
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1, max - lo)) * (H - T - B);

  let d = `M${x(times[0]).toFixed(1)},${y(points[0].final_price).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H${x(times[i]).toFixed(1)} V${y(points[i].final_price).toFixed(1)}`;
  }
  d += ` H${x(t1).toFixed(1)}`;
  const dateLabel = (t: number) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
  const lowIdx = points.reduce((best, p, i) => (p.final_price < points[best].final_price ? i : best), 0);
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="가격 변화 그래프">
  <line x1="${L}" y1="${y(max)}" x2="${W - R}" y2="${y(max)}" stroke="currentColor" stroke-opacity=".15"/>
  <line x1="${L}" y1="${y(min)}" x2="${W - R}" y2="${y(min)}" stroke="currentColor" stroke-opacity=".15"/>
  <text x="${L - 6}" y="${y(max) + 4}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${won(max)}</text>
  <text x="${L - 6}" y="${y(min) + 4}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${won(min)}</text>
  <text x="${L}" y="${H - 8}" font-size="11" fill="currentColor" fill-opacity=".6">${dateLabel(t0)}</text>
  <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity=".6">${dateLabel(t1)}</text>
  <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" class="text-primary"/>
  <circle cx="${x(times[lowIdx]).toFixed(1)}" cy="${y(points[lowIdx].final_price).toFixed(1)}" r="4" class="text-primary" fill="currentColor"/>
</svg>`;
}

export function dealDetailPage(options: {
  deal: DealRow;
  points: PricePoint[];
  origin?: string;
}) {
  const { deal: d, points } = options;
  const chart = priceChartSvg(points);
  const lowest = points.length ? Math.min(...points.map((p) => p.final_price)) : d.final_price;
  return layout({
    title: `${d.title} 가격 추이 · ${SITE_NAME}`,
    description: `${d.title}의 Steam 할인 가격 변화 기록.`,
    current: "deals",
    canonical: `/deals/${d.app_id}`,
    origin: options.origin,
    body: html`<div class="flex flex-col gap-4">
      <a class="text-label-ui font-label-ui text-on-surface-variant hover:text-on-surface" href="/deals">← 할인 목록</a>
      <h1 class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight">${d.title}</h1>
      <div class="flex flex-wrap items-center gap-3 text-body-md font-body-md">
        <span class="px-2 py-1 rounded bg-primary/20 text-primary font-bold">-${d.discount_pct}%</span>
        <span class="line-through text-outline">${won(d.original_price)}</span>
        <span class="font-bold text-on-surface">${won(d.final_price)}</span>
        <span class="text-label-mono-sm font-label-mono-sm text-outline">수집 이후 최저 ${won(lowest)}</span>
      </div>
      <div class="bg-surface-container-low border border-outline-variant rounded p-3 text-on-surface">
        ${chart
          ? raw(chart)
          : html`<p class="text-body-md font-body-md text-on-surface-variant">아직 가격 변화가 기록되지 않았습니다. 가격이 바뀌면 그래프가 그려집니다.</p>`}
      </div>
      <a
        class="self-start px-3 py-1.5 rounded border border-primary/60 text-primary text-label-ui font-label-ui hover:bg-surface-variant"
        href="https://store.steampowered.com/app/${d.app_id}/"
        target="_blank"
        rel="noopener nofollow"
        >Steam에서 보기</a
      >
    </div>`,
  });
}
