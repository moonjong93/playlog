import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { env, rootDir } from "./env.ts";
import { logoPng } from "./brand.ts";
import { toSearchText } from "./sanitize.ts";
import { SITE_NAME, SITE_TAGLINE } from "./site.ts";
import { articleSources, displaySourceName, summaryLines } from "./pages/layout.ts";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const SANS = "Noto Sans KR";
const MONO = "JetBrains Mono";

/** styles.css 의 디자인 토큰과 맞춘 값. */
const C = {
  bg: "#0f131d",
  panel: "#1c1f2a",
  panelHigh: "#262a35",
  onSurface: "#dfe2f1",
  variant: "#c7c4d7",
  outline: "#908fa0",
  outlineVariant: "#464554",
  primary: "#c0c1ff",
  secondary: "#4edea3",
} as const;

type Style = Record<string, string | number>;
type Node = {
  type: string;
  props: {
    style: Style;
    children?: unknown;
    src?: string;
    width?: number;
    height?: number;
  };
};

function el(type: string, style: Style, children?: unknown): Node {
  return { type, props: { style, children } };
}

let logoDataUri: string | undefined;

/** satori 는 SVG 각도 그라디언트를 못 그려서 로고를 PNG 데이터 URI 로 넣는다. */
function logoImage(size: number): Node {
  logoDataUri ??= `data:image/png;base64,${Buffer.from(logoPng(size * 2)).toString("base64")}`;
  return {
    type: "img",
    props: {
      style: { width: size, height: size },
      src: logoDataUri,
      width: size,
      height: size,
    },
  };
}

type Font = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

let fonts: Font[] | undefined;

/** assets/fonts 의 서브셋 폰트(gzip). 첫 렌더에서만 읽는다. */
function ogFonts(): Font[] {
  if (!fonts) {
    const load = (file: string, name: string, weight: 400 | 700): Font => ({
      name,
      weight,
      style: "normal",
      data: gunzipSync(readFileSync(join(rootDir, "assets/fonts", file))),
    });
    fonts = [
      load("NotoSansKR-Regular.ttf.gz", SANS, 400),
      load("NotoSansKR-Bold.ttf.gz", SANS, 700),
      load("JetBrainsMono-Regular.ttf.gz", MONO, 400),
      load("JetBrainsMono-Bold.ttf.gz", MONO, 700),
    ];
  }
  return fonts;
}

/** 폰트에 없는 이모지·변형 선택자는 빈 네모로 그려지므로 지운다. */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}]/gu;

export function cleanOgText(value: string): string {
  return value.replace(EMOJI, "").replace(/\s+/g, " ").trim();
}

export type OgCard = {
  title: string;
  /** 요약 불릿(최대 3줄). */
  bullets: string[];
  /** 하단 태그 칩(최대 3개). */
  tags: string[];
  /** 우측 상단 모노 라벨(보통 날짜). */
  meta: string;
  /** 우측 상단 보조 문구. */
  kicker: string;
  /** 하단 출처 표기(예: `IGN +2`). */
  credit?: string;
};

/** 제목 길이에 따라 제목 크기를 정한다(한글 제목은 길어지기 쉽다). */
function titleSize(title: string): number {
  const n = [...title].length;
  if (n <= 30) return 66;
  if (n <= 46) return 58;
  if (n <= 64) return 50;
  return 42;
}

export function hostLabel(): string {
  if (env.siteUrl) {
    try {
      return new URL(env.siteUrl).host.replace(/^www\./, "").toUpperCase();
    } catch {
      // 아래 기본값으로.
    }
  }
  return SITE_NAME;
}

function header(card: OgCard): Node {
  return el("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
    el("div", { display: "flex", alignItems: "center", gap: 18 }, [
      logoImage(56),
      el("div", { display: "flex", flexDirection: "column", gap: 6 }, [
        el(
          "div",
          {
            fontSize: 30,
            fontWeight: 700,
            color: C.onSurface,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          },
          SITE_NAME,
        ),
        el(
          "div",
          {
            fontFamily: MONO,
            fontSize: 15,
            color: C.outline,
            letterSpacing: "0.18em",
            lineHeight: 1,
          },
          SITE_TAGLINE,
        ),
      ]),
    ]),
    el("div", { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }, [
      el(
        "div",
        { fontFamily: MONO, fontSize: 22, fontWeight: 700, color: C.variant, lineHeight: 1 },
        card.meta ? card.meta : hostLabel(),
      ),
      el(
        "div",
        {
          fontFamily: MONO,
          fontSize: 13,
          color: C.outline,
          letterSpacing: "0.12em",
          lineHeight: 1,
        },
        card.kicker,
      ),
    ]),
  ]);
}

function content(card: OgCard): Node {
  const title = cleanOgText(card.title);
  const bullets = card.bullets
    .map(cleanOgText)
    .filter(Boolean)
    .slice(0, 3);
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      flex: 1,
      justifyContent: "center",
      paddingTop: 14,
    },
    [
      el(
        "div",
        {
          fontSize: titleSize(title),
          fontWeight: 700,
          color: C.onSurface,
          letterSpacing: "-0.025em",
          lineHeight: 1.26,
          lineClamp: 3,
          wordBreak: "keep-all",
        },
        title,
      ),
      bullets.length === 0
        ? null
        : el(
            "div",
            {
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 30,
              paddingLeft: 4,
            },
            bullets.map((line) =>
              el("div", { display: "flex", alignItems: "flex-start", gap: 12 }, [
                el(
                  "div",
                  { color: C.primary, fontSize: 25, fontWeight: 700, lineHeight: 1.4 },
                  "•",
                ),
                el(
                  "div",
                  {
                    color: C.variant,
                    fontSize: 25,
                    lineHeight: 1.4,
                    letterSpacing: "-0.01em",
                    lineClamp: 2,
                    wordBreak: "keep-all",
                  },
                  line,
                ),
              ]),
            ),
          ),
    ],
  );
}

function footer(card: OgCard): Node {
  const tags = card.tags.map(cleanOgText).filter(Boolean).slice(0, 3);
  const credit = card.credit ? cleanOgText(card.credit) : "";
  return el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }, [
    el(
      "div",
      { display: "flex", alignItems: "center", gap: 10 },
      tags.map((tag) =>
        el(
          "div",
          {
            display: "flex",
            alignItems: "center",
            padding: "7px 14px",
            borderRadius: 4,
            backgroundColor: C.panelHigh,
            color: C.primary,
            fontSize: 19,
            fontWeight: 500,
          },
          `#${tag}`,
        ),
      ),
    ),
    el("div", { display: "flex", alignItems: "center", gap: 18 }, [
      credit
        ? el("div", { fontSize: 18, color: C.variant, lineClamp: 1 }, `출처 ${credit}`)
        : null,
      el(
        "div",
        { fontFamily: MONO, fontSize: 17, fontWeight: 700, color: C.outline, letterSpacing: "0.1em" },
        hostLabel(),
      ),
    ]),
  ]);
}

function card(cardInput: OgCard): Node {
  return el(
    "div",
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      display: "flex",
      flexDirection: "column",
      backgroundColor: C.bg,
      backgroundImage:
        "radial-gradient(circle at 88% 8%, rgba(192,193,255,0.16), transparent 46%)," +
        "radial-gradient(circle at 4% 98%, rgba(78,222,163,0.10), transparent 44%)",
      fontFamily: SANS,
      color: C.onSurface,
    },
    [
      el("div", {
        height: 4,
        width: OG_WIDTH,
        backgroundImage: `linear-gradient(90deg, ${C.primary}, ${C.secondary})`,
      }),
      el("div", { display: "flex", flexDirection: "column", flex: 1, padding: "46px 64px 44px" }, [
        header(cardInput),
        el("div", { height: 1, backgroundColor: C.outlineVariant, marginTop: 28 }),
        content(cardInput),
        footer(cardInput),
      ]),
    ],
  );
}

async function render(cardInput: OgCard): Promise<Uint8Array> {
  const svg = await satori(card(cardInput), {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts: ogFonts(),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
    font: { loadSystemFonts: false },
  });
  return new Uint8Array(resvg.render().asPng());
}

const CACHE_MAX = 200;
const cache = new Map<string, Uint8Array>();
const pending = new Map<string, Promise<Uint8Array>>();

/** 키(슬러그+수정시각)로 캐시하고, 동시 요청은 한 번만 렌더한다. */
export function ogPng(key: string, cardInput: OgCard): Promise<Uint8Array> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const waiting = pending.get(key);
  if (waiting) return waiting;

  const job = render(cardInput)
    .then((png) => {
      cache.set(key, png);
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return png;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, job);
  return job;
}

/** 불릿 하나의 최대 길이. 넘으면 잘라내고 말줄임표를 붙인다. */
const BULLET_MAX = 96;

function trimBullet(line: string): string {
  const text = cleanOgText(line);
  if ([...text].length <= BULLET_MAX) return text;
  return `${[...text].slice(0, BULLET_MAX - 1).join("").replace(/[\s,·]+$/, "")}…`;
}

/** 본문 평문에서 첫 문장 몇 개를 불릿으로 쓴다(리드가 없을 때). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
}

/** 요약 판정을 통과하지 못한 짧은 리드도 불릿으로 쓴다. */
function plainLines(text: string): string[] {
  return (text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^[•*\-\d.\s]+/, "").trim())
    .filter(Boolean);
}

/** OG 불릿: 리드 요약 → 리드 줄 → 본문 앞부분. 최대 3줄. */
export function ogBullets(lede: string, bodyText = ""): string[] {
  const summary = summaryLines(lede).filter(Boolean);
  const fromLede = plainLines(lede);
  const source =
    summary.length > 0 ? summary : fromLede.length > 0 ? fromLede : sentences(bodyText);
  return source.slice(0, 3).map(trimBullet).filter(Boolean);
}

function kstDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", dateStyle: "short" })
    .format(date)
    .replace(/-/g, ".");
}

/** 출처 표기: 중복을 합쳐 2개까지 이름을 쓰고 나머지는 `+N`. */
export function creditLabel(sourcesJson: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const source of articleSources(sourcesJson)) {
    let name = source.name?.trim() ?? "";
    if (name) name = displaySourceName(name);
    else if (source.url) {
      try {
        name = new URL(source.url).hostname.replace(/^www\./, "");
      } catch {
        name = source.url;
      }
    }
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) return "";
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

export function articleOgCard(article: {
  title_ko: string;
  lede_ko: string;
  body_html: string;
  sources_json: string;
  published_at: string;
  tags?: string[];
}): OgCard {
  return {
    title: article.title_ko,
    bullets: ogBullets(article.lede_ko, toSearchText(article.body_html)),
    tags: article.tags ?? [],
    meta: kstDate(article.published_at),
    kicker: "GAME NEWS & STORIES",
    credit: creditLabel(article.sources_json),
  };
}

export const DEFAULT_OG_KEY = "site-default";

export function defaultOgCard(): OgCard {
  return {
    title: "게임 업계 뉴스 & 스토리",
    bullets: [
      "해외 매체와 커뮤니티 반응을 한 번에",
      "3줄 핵심 요약과 원문 출처",
      "태그로 관심 주제만 골라 읽기",
    ],
    tags: [],
    meta: SITE_NAME,
    kicker: "GAME NEWS & STORIES",
  };
}
