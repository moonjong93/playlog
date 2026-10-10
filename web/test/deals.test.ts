import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app, cleanup, query, run } from "./helpers.ts";
import { parseFeatured, parseSearchHtml, saveDeals } from "../src/deals.ts";
import { priceChartSvg } from "../src/pages/deals.ts";

afterAll(() => cleanup());

function row(opts: {
  id: string; title: string; pct: number; orig: string; final: number; tip?: string;
}): string {
  return `<a href="https://store.steampowered.com/app/${opts.id}/x/" data-ds-appid="${opts.id}" class="search_result_row ds_collapse_flag ">
    <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${opts.id}/c.jpg?t=1" ></div>
    <span class="title">${opts.title}</span>
    ${opts.tip ? `<span class="search_review_summary positive" data-tooltip-html="${opts.tip}"></span>` : ""}
    <div class="search_price_discount_combined" data-price-final="${opts.final}">
      <div class="discount_block search_discount_block" data-price-final="${opts.final}" data-discount="${opts.pct}"><div class="discount_pct">-${opts.pct}%</div><div class="discount_prices"><div class="discount_original_price">${opts.orig}</div></div></div>
    </div></a>`;
}

const TIP =
  "매우 긍정적&lt;br&gt;이 게임에 대한 사용자 평가 3,328개 중 90%가 긍정적입니다.";

describe("parseSearchHtml", () => {
  it("제목·할인율·원화 가격·평가를 뽑는다", () => {
    const [d] = parseSearchHtml(
      row({ id: "632360", title: "Risk &amp; Rain", pct: 67, orig: "₩ 26,000", final: 858000, tip: TIP }),
    );
    expect(d).toMatchObject({
      appId: 632360, title: "Risk & Rain", discountPct: 67,
      originalPrice: 26000, finalPrice: 8580,
      reviewPct: 90, reviewCount: 3328, reviewLabel: "매우 긍정적",
    });
    expect(d.imageUrl).toContain("steamstatic.com");
  });

  it("평가가 없어도 파싱하고, 중복·번들·비정상 행은 건너뛴다", () => {
    const htmlText = [
      row({ id: "1", title: "A", pct: 50, orig: "₩ 10,000", final: 500000 }),
      row({ id: "1", title: "A dup", pct: 50, orig: "₩ 10,000", final: 500000 }),
      row({ id: "1,2", title: "Bundle", pct: 50, orig: "₩ 10,000", final: 500000 }),
      row({ id: "3", title: "No discount", pct: 0, orig: "₩ 10,000", final: 1000000 }),
    ].join("");
    const deals = parseSearchHtml(htmlText);
    expect(deals.map((d) => d.appId)).toEqual([1]);
    expect(deals[0].reviewPct).toBeNull();
  });

  it("허용되지 않은 이미지 호스트는 버린다", () => {
    const evil = row({ id: "9", title: "X", pct: 10, orig: "₩ 1,000", final: 90000 }).replace(
      "shared.fastly.steamstatic.com", "evil.example.com",
    );
    expect(parseSearchHtml(evil)[0].imageUrl).toBeNull();
  });
});

describe("parseFeatured", () => {
  it("할인 종료 시각을 ISO로 바꾼다", () => {
    const m = parseFeatured({ specials: { items: [{ id: 5, discount_expiration: 1792688400 }, { id: 6 }] } });
    expect(m.get(5)).toBe(new Date(1792688400 * 1000).toISOString());
    expect(m.has(6)).toBe(false);
    expect(parseFeatured(null).size).toBe(0);
  });
});

const mk = (id: number, pct: number, price: number) => ({
  appId: id, title: `Game ${id}`, discountPct: pct, originalPrice: price * 2, finalPrice: price,
  imageUrl: null, reviewPct: 80, reviewCount: 100, reviewLabel: "긍정적",
});

describe("saveDeals + /deals", () => {
  beforeEach(() => {
    run("DELETE FROM deals");
    run("DELETE FROM price_history");
    delete process.env.DEALS_PRICE_UI;
  });

  it("재수집 시 사라진 행은 지우고 first_seen_at 은 보존한다", () => {
    saveDeals([mk(1, 50, 1000), mk(2, 30, 500)], new Map(), "2026-01-01T00:00:00.000Z");
    saveDeals([mk(2, 40, 400), mk(3, 70, 300)], new Map(), "2026-01-02T00:00:00.000Z");
    const rows = query<{ app_id: number; first_seen_at: string; discount_pct: number }>(
      "SELECT app_id, first_seen_at, discount_pct FROM deals ORDER BY app_id",
    );
    expect(rows).toEqual([
      { app_id: 2, first_seen_at: "2026-01-01T00:00:00.000Z", discount_pct: 40 },
      { app_id: 3, first_seen_at: "2026-01-02T00:00:00.000Z", discount_pct: 70 },
    ]);
  });

  it("정렬·최소 할인율 필터가 동작한다", async () => {
    saveDeals([mk(1, 30, 3000), mk(2, 80, 2000), mk(3, 50, 1000)], new Map());
    const titles = (t: string) => [...t.matchAll(/>(Game \d)</g)].map((m) => m[1]);

    let res = await app.request("/deals");
    expect(res.status).toBe(200);
    expect(titles(await res.text())).toEqual(["Game 1", "Game 2", "Game 3"]);

    res = await app.request("/deals?sort=discount");
    expect(titles(await res.text())).toEqual(["Game 2", "Game 3", "Game 1"]);

    res = await app.request("/deals?sort=price");
    expect(titles(await res.text())).toEqual(["Game 3", "Game 2", "Game 1"]);

    res = await app.request("/deals?min=50");
    expect(titles(await res.text())).toEqual(["Game 2", "Game 3"]);
  });

  it("잘못된 파라미터는 기본값으로, 빈 목록은 안내 문구", async () => {
    let res = await app.request("/deals?sort=evil&min=999");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("불러오는 중");
    saveDeals([mk(1, 30, 3000)], new Map());
    res = await app.request("/deals?min=75");
    expect(await res.text()).toContain("조건에 맞는 할인이 없습니다");
  });

  it("헤더 네비와 sitemap 에 노출된다", async () => {
    expect(await (await app.request("/")).text()).toContain('href="/deals"');
    expect(await (await app.request("/sitemap.xml")).text()).toContain("/deals</loc>");
  });
});

describe("가격 이력", () => {
  beforeEach(() => {
    run("DELETE FROM deals");
    run("DELETE FROM price_history");
    delete process.env.DEALS_PRICE_UI;
  });
  const hist = () =>
    query<{ app_id: number; final_price: number; discount_pct: number }>(
      "SELECT app_id, final_price, discount_pct FROM price_history ORDER BY id",
    );

  it("가격이 바뀔 때만 기록하고, 할인 종료는 정가로 기록한다", () => {
    saveDeals([mk(1, 50, 1000)], new Map(), "2026-01-01T00:00:00.000Z");
    saveDeals([mk(1, 50, 1000)], new Map(), "2026-01-01T01:00:00.000Z"); // 동일 → 기록 안 함
    saveDeals([mk(1, 70, 600)], new Map(), "2026-01-02T00:00:00.000Z"); // 변동
    saveDeals([mk(2, 10, 900)], new Map(), "2026-01-03T00:00:00.000Z"); // 1번 종료
    expect(hist()).toEqual([
      { app_id: 1, final_price: 1000, discount_pct: 50 },
      { app_id: 1, final_price: 600, discount_pct: 70 },
      { app_id: 2, final_price: 900, discount_pct: 10 },
      { app_id: 1, final_price: 1200, discount_pct: 0 },
    ]);
  });

  it("UI 스위치가 꺼져 있으면 상세는 404, 켜면 그래프가 나온다", async () => {
    saveDeals([mk(1, 50, 1000)], new Map(), "2026-01-01T00:00:00.000Z");
    saveDeals([mk(1, 70, 600)], new Map(), "2026-01-02T00:00:00.000Z");
    expect((await app.request("/deals/1")).status).toBe(404);
    expect(await (await app.request("/deals")).text()).not.toContain("수집 이후 최저가");

    process.env.DEALS_PRICE_UI = "1";
    const res = await app.request("/deals/1");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("Steam에서 보기");
    expect(await (await app.request("/deals")).text()).toContain("수집 이후 최저가");
    expect((await app.request("/deals/999")).status).toBe(404);
    expect((await app.request("/deals/abc")).status).toBe(404);
  });

  it("점이 1개면 그래프를 그리지 않는다", () => {
    expect(priceChartSvg([])).toBe("");
  });
});
