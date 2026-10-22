import { html } from "hono/html";
import type { SeoCheck, SeoCheckpoint, SeoReport, SeoSnapshot } from "../seoMonitor.ts";
import { SITE_NAME, NOINDEX } from "../site.ts";
import { formatTime, layout, type Html } from "./layout.ts";

/**
 * /internal/seo — 색인 준비 상태 대시보드.
 *
 * Search Console 의 노출·클릭·색인 수는 사람이 콘솔에서 확인해야 하지만,
 * 그 값들이 움직이기 전에 먼저 변하는 값(색인 대상 수·얇은 글 비율·발행 속도·
 * 사이트맵 규모)은 여기서 매일 확인할 수 있게 한다.
 */

const STATUS_STYLE: Record<
  SeoCheck["status"],
  { text: string; bg: string; border: string; label: string }
> = {
  ok: { text: "text-primary", bg: "bg-primary-container", border: "border-l-primary", label: "양호" },
  warn: {
    text: "text-tertiary",
    bg: "bg-tertiary-container",
    border: "border-l-tertiary",
    label: "주의",
  },
  bad: { text: "text-error", bg: "bg-error-container", border: "border-l-error", label: "개선 필요" },
  info: {
    text: "text-on-surface-variant",
    bg: "bg-surface-container",
    border: "border-l-outline",
    label: "참고",
  },
};

function card(label: string, value: string, note: string, tone = "text-on-surface"): Html {
  return html`<div
    class="flex flex-col gap-1 p-4 bg-surface-container-low border border-outline-variant rounded"
  >
    <span class="text-label-mono-sm font-label-mono-sm text-outline">${label}</span>
    <span class="text-headline-sm font-headline-sm font-bold ${tone}">${value}</span>
    <span class="text-label-mono-sm font-label-mono-sm text-on-surface-variant">${note}</span>
  </div>`;
}

function bar(label: string, count: number, total: number, tone: string): Html {
  const ratio = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
  return html`<div class="flex flex-col gap-1">
    <div class="flex items-center justify-between text-label-mono-sm font-label-mono-sm">
      <span class="text-on-surface-variant">${label}</span>
      <span class="text-outline">${count}편 · ${ratio}%</span>
    </div>
    <div class="h-2 w-full bg-surface-container rounded overflow-hidden">
      <div class="h-full ${tone}" style="width:${Math.min(100, ratio)}%"></div>
    </div>
  </div>`;
}

function checkRow(check: SeoCheck): Html {
  const style = STATUS_STYLE[check.status];
  return html`<tr>
    <td class="py-2 pr-3 whitespace-nowrap align-top">
      <span class="px-2 py-0.5 rounded text-label-mono-sm font-label-mono-sm ${style.bg} ${style.text}"
        >${style.label}</span
      >
    </td>
    <td class="py-2 pr-3 text-body-sm font-body-sm text-on-surface align-top">${check.label}</td>
    <td class="py-2 pr-3 text-body-sm font-body-sm text-on-surface-variant align-top">
      ${check.detail}
      <span class="block text-label-mono-sm font-label-mono-sm text-outline">${check.hint}</span>
    </td>
  </tr>`;
}

function historyTable(rows: SeoSnapshot[]): Html {
  if (rows.length === 0) {
    return html`<p class="text-body-sm font-body-sm text-on-surface-variant">
      아직 스냅샷이 없습니다. 대시보드를 열 때 6시간 간격으로 자동 기록됩니다.
    </p>`;
  }
  const head = html`<tr class="text-label-mono-sm font-label-mono-sm text-outline">
    <th class="text-left py-1 pr-3 font-normal">기록 시각</th>
    <th class="text-right py-1 pr-3 font-normal">전체</th>
    <th class="text-right py-1 pr-3 font-normal">색인 대상</th>
    <th class="text-right py-1 pr-3 font-normal">500자 미만</th>
    <th class="text-right py-1 pr-3 font-normal">출처부족</th>
    <th class="text-right py-1 pr-3 font-normal">태그</th>
    <th class="text-right py-1 font-normal">사이트맵</th>
  </tr>`;
  const body = rows.map(
    (row) => html`<tr class="text-body-sm font-body-sm text-on-surface-variant">
      <td class="py-1 pr-3 whitespace-nowrap">${formatTime(row.taken_at)}</td>
      <td class="py-1 pr-3 text-right">${row.total_articles}</td>
      <td class="py-1 pr-3 text-right text-primary">${row.indexable_articles}</td>
      <td class="py-1 pr-3 text-right">${row.thin_articles}</td>
      <td class="py-1 pr-3 text-right">${row.single_source_articles}</td>
      <td class="py-1 pr-3 text-right">${row.indexable_tags}</td>
      <td class="py-1 text-right">${row.sitemap_urls}</td>
    </tr>`,
  );
  return html`<div class="overflow-x-auto">
    <table class="w-full border-collapse">
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function checkpointTable(rows: (SeoCheckpoint & { reached: boolean })[]): Html {
  const cells = rows.map(
    (row) => html`<tr class="align-top">
      <td class="py-2 pr-3 whitespace-nowrap text-label-mono-sm font-label-mono-sm ${row.reached ? "text-primary" : "text-outline"}">
        D+${row.day}<span class="block text-outline">${row.date}</span>
      </td>
      <td class="py-2 pr-3 text-body-sm font-body-sm text-on-surface-variant">
        <span class="block text-on-surface">${row.watch}</span>
        <span class="block text-primary">기대: ${row.target}</span>
        <span class="block text-outline">못 넘으면: ${row.fallback}</span>
      </td>
    </tr>`,
  );
  return html`<div class="overflow-x-auto">
    <table class="w-full border-collapse"><tbody>${cells}</tbody></table>
  </div>`;
}

export function seoStatusPage(options: {
  report: SeoReport;
  history: SeoSnapshot[];
  checkpoints: (SeoCheckpoint & { reached: boolean })[];
  origin?: string;
}) {
  const { report } = options;
  const a = report.stats.articles;
  const s = report.stats.sitemap;
  const verdict = STATUS_STYLE[report.verdict];
  const consoleUrl =
    "https://search.google.com/search-console?resource_id=https%3A%2F%2Fnews.nevra.app%2F";

  return layout({
    title: `SEO 관측 · ${SITE_NAME}`,
    robots: NOINDEX,
    current: "none",
    origin: options.origin,
    body: html`<div class="flex flex-col gap-6">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h1 class="text-headline-lg font-headline-lg font-bold text-on-surface tracking-tight">
          SEO 관측
        </h1>
        <span class="text-label-mono-sm font-label-mono-sm text-outline"
          >기준 ${formatTime(report.stats.generatedAt)}</span
        >
      </div>

      <div
        class="p-4 bg-surface-container-low border border-outline-variant border-l-2 ${verdict.border} rounded flex flex-col gap-1"
      >
        <span class="text-label-mono-sm font-label-mono-sm ${verdict.text}">현재 판정</span>
        <span class="text-headline-sm font-headline-sm font-bold ${verdict.text}"
          >${verdict.label}</span
        >
        <span class="text-body-sm font-body-sm text-on-surface-variant"
          >색인 대상 ${a.indexable}편 · 사이트맵 ${s.total}개 URL · 최근 7일 하루 평균
          ${a.recent.perDay7d}편</span
        >
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${card("전체 기사", String(a.total), "누적 발행")}
        ${card("색인 대상", String(a.indexable), `전체의 ${a.total ? Math.round((a.indexable / a.total) * 1000) / 10 : 0}%`, "text-primary")}
        ${card("noindex", String(a.excluded), "사용자에게만 노출")}
        ${card("사이트맵 URL", String(s.total), `기사 ${s.articles} · 태그 ${s.tags} · 고정 ${s.fixed}`)}
        ${card("본문 500자 미만", String(a.body.under500), "짧은 브리핑 — 설계")}
        ${card(`출처 ${report.stats.thresholds.minSources}개 미만`, String(a.fewSources), "여러 매체가 다룬 사건만 색인")}
        ${card("색인 태그 페이지", String(report.stats.tags.indexable), `전체 태그 ${report.stats.tags.total}개 중`)}
        ${card("하루 평균 발행", `${a.recent.perDay7d}편`, `최근 24시간 ${a.recent.last24h}편`)}
      </div>

      <div class="flex flex-col gap-3">
        <h2 class="text-headline-sm font-headline-sm font-bold text-on-surface">본문 길이 분포</h2>
        ${bar("500자 미만", a.body.under500, a.total, "bg-error")}
        ${bar("500~899자", a.body.from500to899, a.total, "bg-tertiary")}
        ${bar("900자 이상", a.body.from900, a.total, "bg-primary")}
      </div>

      <div class="flex flex-col gap-3">
        <h2 class="text-headline-sm font-headline-sm font-bold text-on-surface">점검 항목</h2>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse">
            <tbody>
              ${report.checks.map(checkRow)}
            </tbody>
          </table>
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <h2 class="text-headline-sm font-headline-sm font-bold text-on-surface">관찰 계획</h2>
        <p class="text-body-sm font-body-sm text-on-surface-variant">
          신뢰가 0인 도메인은 지표를 고쳐서 색인을 앞당길 수 없다. 아래 시점에 Search Console
          숫자를 보고 다음 수를 정한다.
        </p>
        ${checkpointTable(options.checkpoints)}
      </div>

      <div class="flex flex-col gap-3">
        <h2 class="text-headline-sm font-headline-sm font-bold text-on-surface">추이</h2>
        ${historyTable(options.history)}
      </div>

      <div
        class="p-4 bg-surface-container-low border border-outline-variant rounded flex flex-col gap-2 text-body-sm font-body-sm text-on-surface-variant"
      >
        <span class="text-on-surface font-semibold">색인 기준 (indexing.ts)</span>
        <span
          >출처 ${report.stats.thresholds.minSources}개 이상 <span class="text-outline">또는</span>
          본문 ${report.stats.thresholds.minBodyChars}자 이상 → 색인 대상. 태그 페이지는 색인 기사
          ${report.stats.thresholds.minTagArticles}건 이상일 때만 색인. 기준 밖은
          <code class="text-primary">noindex, follow</code> + 사이트맵 제외.</span
        >
        <span
          >구글 실제 색인 수치는
          <a class="text-primary underline" href="${consoleUrl}" target="_blank" rel="noopener"
            >Search Console</a
          >에서 확인합니다. 이 화면은 그 값이 움직이기 전에 변하는 선행 지표만 봅니다.</span
        >
        <span class="text-outline"
          >JSON: <code class="text-primary">/internal/seo.json</code> (Bearer 또는
          <code class="text-primary">?token=</code>)</span
        >
      </div>
    </div>`,
  });
}
