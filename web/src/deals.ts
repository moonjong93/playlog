import { query, queryOne, transaction, run } from "./db.ts";

/** Steam 스토어 공개 엔드포인트(키 불필요). cc=kr 이라 가격이 원화다. */
const SEARCH_URL =
  "https://store.steampowered.com/search/results/?query&start=0&count=100" +
  "&specials=1&infinite=1&cc=kr&l=koreana&category1=998";
const FEATURED_URL =
  "https://store.steampowered.com/api/featuredcategories?cc=kr&l=koreana";

export const REFRESH_MS = 60 * 60 * 1000;
/** 이보다 적게 파싱되면 Steam 마크업이 바뀌었거나 응답이 깨진 것으로 보고 기존 목록을 지킨다. */
const MIN_ROWS = 10;
/** NEW 배지는 첫 수집 후 이 시간이 지나야 의미가 있다(처음엔 전부 새것이라). */
export const NEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ParsedDeal = {
  appId: number;
  title: string;
  discountPct: number;
  originalPrice: number;
  finalPrice: number;
  imageUrl: string | null;
  reviewPct: number | null;
  reviewCount: number | null;
  reviewLabel: string | null;
};

export type DealRow = {
  app_id: number;
  title: string;
  discount_pct: number;
  original_price: number;
  final_price: number;
  image_url: string | null;
  review_pct: number | null;
  review_count: number | null;
  review_label: string | null;
  expires_at: string | null;
  rank: number;
  first_seen_at: string;
  seen_at: string;
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

function digits(text: string): number {
  return Number(text.replace(/[^\d]/g, ""));
}

const IMAGE_HOSTS = /^https:\/\/(shared\.[a-z]+\.steamstatic\.com|cdn\.[a-z]+\.steamstatic\.com|cdn\.akamai\.steamstatic\.com)\//;

/** Steam 검색 결과 HTML 한 덩어리를 할인 행 목록으로 바꾼다. 검색 순서(인기순)를 유지한다. */
export function parseSearchHtml(htmlText: string): ParsedDeal[] {
  const deals: ParsedDeal[] = [];
  const seen = new Set<number>();
  // 행은 `<a ... class="search_result_row">` 로 시작하고 appid 가 class 앞에 있어, <a 앞에서 자른다.
  for (const chunk of htmlText.split(/(?=<a\s[^>]*class="search_result_row)/)) {
    if (!chunk.startsWith("<a")) continue;
    const appId = chunk.match(/data-ds-appid="(\d+)"/)?.[1];
    const title = chunk.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1];
    const pct = chunk.match(/data-discount="(\d+)"/)?.[1];
    const original = chunk.match(/class="discount_original_price">([^<]+)</)?.[1];
    const final = chunk.match(/data-price-final="(\d+)"/)?.[1];
    if (!appId || !title || !pct || !original || !final) continue;
    const id = Number(appId);
    const discountPct = Number(pct);
    const originalPrice = digits(original);
    // data-price-final 은 센트 단위(원화도 ×100)다.
    const finalPrice = Math.round(Number(final) / 100);
    if (seen.has(id) || discountPct <= 0 || !originalPrice) continue;
    seen.add(id);

    const image = chunk.match(/class="search_capsule"><img src="([^"]+)"/)?.[1];
    const tooltip = chunk.match(/data-tooltip-html="([^"]*)"/)?.[1] ?? "";
    const decodedTip = decode(tooltip);
    const review = decodedTip.match(/평가\s*([\d,]+)개 중\s*(\d+)%/);
    const label = decodedTip.split("<br>")[0]?.trim();

    deals.push({
      appId: id,
      title: decode(title),
      discountPct,
      originalPrice,
      finalPrice,
      imageUrl: image && IMAGE_HOSTS.test(image) ? image : null,
      reviewPct: review ? Number(review[2]) : null,
      reviewCount: review ? digits(review[1]) : null,
      reviewLabel: label && review ? label : null,
    });
  }
  return deals;
}

/** featuredcategories 의 할인 종료 시각(unix 초)을 app id → ISO 로 모은다. */
export function parseFeatured(json: unknown): Map<number, string> {
  const out = new Map<number, string>();
  const items = (json as { specials?: { items?: unknown[] } })?.specials?.items;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const { id, discount_expiration: exp } = item as { id?: number; discount_expiration?: number };
    if (typeof id === "number" && typeof exp === "number" && exp > 0) {
      out.set(id, new Date(exp * 1000).toISOString());
    }
  }
  return out;
}

type HistoryRow = {
  final_price: number;
  original_price: number;
  discount_pct: number;
  recorded_at: string;
};

/** 마지막 기록과 다를 때만 이력을 한 줄 추가한다. */
function recordPrice(
  appId: number,
  finalPrice: number,
  originalPrice: number,
  discountPct: number,
  now: string,
): void {
  const last = queryOne<HistoryRow>(
    "SELECT * FROM price_history WHERE app_id = ? ORDER BY id DESC LIMIT 1",
    [appId],
  );
  if (last && last.final_price === finalPrice && last.original_price === originalPrice) return;
  run(
    `INSERT INTO price_history (app_id, final_price, original_price, discount_pct, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [appId, finalPrice, originalPrice, discountPct, now],
  );
}

/** 새 목록으로 통째로 교체한다. 사라진 행(할인 종료)은 지우고 first_seen_at 은 보존한다. */
export function saveDeals(
  deals: ParsedDeal[],
  expirations: Map<number, string>,
  now = new Date().toISOString(),
): void {
  transaction(() => {
    const upsert = `INSERT INTO deals (app_id, title, discount_pct, original_price, final_price,
        image_url, review_pct, review_count, review_label, expires_at, rank, first_seen_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET
        title = excluded.title, discount_pct = excluded.discount_pct,
        original_price = excluded.original_price, final_price = excluded.final_price,
        image_url = excluded.image_url, review_pct = excluded.review_pct,
        review_count = excluded.review_count, review_label = excluded.review_label,
        expires_at = excluded.expires_at, rank = excluded.rank, seen_at = excluded.seen_at`;
    deals.forEach((d, i) => {
      run(upsert, [
        d.appId, d.title, d.discountPct, d.originalPrice, d.finalPrice, d.imageUrl,
        d.reviewPct, d.reviewCount, d.reviewLabel, expirations.get(d.appId) ?? null,
        i + 1, now, now,
      ]);
      recordPrice(d.appId, d.finalPrice, d.originalPrice, d.discountPct, now);
    });
    // 할인이 끝난 행은 정가로 돌아간 것으로 기록한 뒤 지운다(그래프가 끝나는 지점).
    for (const ended of query<{ app_id: number; original_price: number }>(
      "SELECT app_id, original_price FROM deals WHERE seen_at <> ?",
      [now],
    )) {
      recordPrice(ended.app_id, ended.original_price, ended.original_price, 0, now);
    }
    run("DELETE FROM deals WHERE seen_at <> ?", [now]);
  });
}

async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "playlog-deals/1.0", Accept: accept, "Accept-Language": "ko-KR,ko;q=0.9" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** Steam 에서 받아 저장한다. 실패하면 기존 목록을 그대로 둔다. 저장 건수를 돌려준다. */
export async function refreshDeals(): Promise<number> {
  const search = JSON.parse(await fetchText(SEARCH_URL, "application/json")) as {
    results_html?: string;
  };
  const deals = parseSearchHtml(search.results_html ?? "");
  if (deals.length < MIN_ROWS) {
    throw new Error(`파싱된 할인이 너무 적음(${deals.length}건) — 기존 목록 유지`);
  }
  let expirations = new Map<number, string>();
  try {
    expirations = parseFeatured(JSON.parse(await fetchText(FEATURED_URL, "application/json")));
  } catch (err) {
    console.warn("[deals] 종료시각 조회 실패(무시):", (err as Error).message);
  }
  saveDeals(deals, expirations);
  return deals.length;
}

/** 가격 이력 UI(상세 그래프·최저가 배지) 노출 스위치. 수집은 항상 하고, 화면만 .env 로 켠다. */
export function priceHistoryUiEnabled(): boolean {
  return process.env.DEALS_PRICE_UI?.trim() === "1";
}

export type PricePoint = HistoryRow;

export function priceHistory(appId: number): PricePoint[] {
  return query<PricePoint>(
    "SELECT final_price, original_price, discount_pct, recorded_at FROM price_history WHERE app_id = ? ORDER BY id",
    [appId],
  );
}

/** 수집 이후 최저가. 기록이 2건 미만이면 비교 의미가 없어 빼 둔다. */
export function lowestPrices(): Map<number, number> {
  const rows = query<{ app_id: number; low: number }>(
    `SELECT app_id, MIN(final_price) AS low FROM price_history
     GROUP BY app_id HAVING COUNT(*) >= 2`,
  );
  return new Map(rows.map((r) => [r.app_id, r.low]));
}

export function getDeal(appId: number): DealRow | undefined {
  return queryOne<DealRow>("SELECT * FROM deals WHERE app_id = ?", [appId]);
}

export type DealSort = "popular" | "discount" | "price" | "new";
export const DEAL_SORTS: Record<DealSort, { label: string; order: string }> = {
  popular: { label: "인기순", order: "rank ASC" },
  discount: { label: "할인율순", order: "discount_pct DESC, rank ASC" },
  price: { label: "낮은 가격순", order: "final_price ASC, rank ASC" },
  new: { label: "신규 할인", order: "first_seen_at DESC, rank ASC" },
};

export function listDeals(sort: DealSort, minDiscount: number): DealRow[] {
  return query<DealRow>(
    `SELECT * FROM deals WHERE discount_pct >= ? ORDER BY ${DEAL_SORTS[sort].order}`,
    [minDiscount],
  );
}

export function dealsMeta(): { updatedAt: string | null; newBadges: boolean } {
  const row = queryOne<{ updated: string | null; oldest: string | null }>(
    "SELECT MAX(seen_at) AS updated, MIN(first_seen_at) AS oldest FROM deals",
  );
  const oldest = row?.oldest ? Date.parse(row.oldest) : NaN;
  return {
    updatedAt: row?.updated ?? null,
    newBadges: Number.isFinite(oldest) && Date.now() - oldest >= NEW_WINDOW_MS,
  };
}

/** 기동 시 한 번(데이터가 오래됐을 때만), 이후 주기적으로 갱신한다. */
export function startDealsScheduler(): void {
  if (process.env.DEALS_DISABLED?.trim() === "1") return;
  const tick = async () => {
    try {
      const n = await refreshDeals();
      console.log(`[deals] Steam 할인 ${n}건 갱신`);
    } catch (err) {
      console.warn("[deals] 갱신 실패:", (err as Error).message);
    }
  };
  const updated = dealsMeta().updatedAt;
  const stale = !updated || Date.now() - Date.parse(updated) > REFRESH_MS / 2;
  if (stale) setTimeout(tick, 3_000).unref();
  setInterval(tick, REFRESH_MS).unref();
}
