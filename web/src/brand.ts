import { Resvg } from "@resvg/resvg-js";
import { SITE_DESCRIPTION, SITE_NAME } from "./site.ts";

/**
 * 로고 마크: 접힌 리본으로 만든 P + 플레이 버튼(`assets/logo.svg` 원본).
 * 폰트 없이 그려지므로 favicon·앱 아이콘 어디서든 같은 모양이 나온다.
 */
const MARK_PATHS = [
  "M212.688 169.633C200.636 166.629 197.623 179.646 197.623 184.653V289.796L111 334.857V132.082L212.688 72L401 169.633V282.286L223.987 379.918V289.796C251.606 276.027 309.104 246.237 318.143 237.225C327.182 228.212 321.909 223.456 318.143 222.204C288.013 205.932 224.74 172.637 212.688 169.633Z",
  "M197.623 393.852V304.514L111 350.071V440L197.623 393.852Z",
];

/**
 * 원본은 SVG 표준에 없는 각도(conic) 그라디언트라서 그대로는 resvg 가 못 그린다.
 * 중심에서 뻗은 부채꼴 36조각으로 같은 색을 칠한다(원본과 픽셀 오차 평균 0.6/255).
 */
const GRADIENT_CENTER = { x: 233.062, y: 244.96 };
const GRADIENT_SEAM_DEG = 108;
const GRADIENT_FROM = [0xc0, 0xc1, 0xff] as const;
const GRADIENT_TO = [0x33, 0x72, 0xff] as const;
const WEDGE_COUNT = 36;
const WEDGE_RADIUS = 400;
/** 이웃 조각의 안티에일리어싱 틈으로 배경이 비치지 않게 겹쳐 그린다(도). */
const WEDGE_OVERLAP_DEG = 1;

function rgbHex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function point(deg: number): string {
  const rad = (deg * Math.PI) / 180;
  const x = (Math.cos(rad) * WEDGE_RADIUS).toFixed(1);
  const y = (Math.sin(rad) * WEDGE_RADIUS).toFixed(1);
  return `${x} ${y}`;
}

const WEDGE_FAN = Array.from({ length: WEDGE_COUNT }, (_, i) => {
  const t = (i + 0.5) / WEDGE_COUNT;
  const color = rgbHex(
    GRADIENT_FROM.map((from, k) => Math.round(from + (GRADIENT_TO[k] - from) * t)),
  );
  // 뒤 조각이 앞 조각의 꼬리를 덮게 해서 AA 틈을 없앤다. 심(seam) 위치는 그대로 둔다.
  const start = GRADIENT_SEAM_DEG + (i * 360) / WEDGE_COUNT - (i > 0 ? WEDGE_OVERLAP_DEG : 0);
  const end = GRADIENT_SEAM_DEG + ((i + 1) * 360) / WEDGE_COUNT;
  return `<path fill="${color}" d="M0 0L${point(start)}L${point(end)}Z"/>`;
}).join("");

export function logoSvg(size: number): string {
  const clip = MARK_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 512 512" fill="none">` +
    `<defs><clipPath id="mark">${clip}</clipPath></defs>` +
    `<g clip-path="url(#mark)">` +
    `<g transform="translate(${GRADIENT_CENTER.x} ${GRADIENT_CENTER.y})">${WEDGE_FAN}</g>` +
    `</g></svg>`
  );
}

const iconCache = new Map<number, Uint8Array>();

/** 로고 PNG(정사각). 크기별로 한 번만 렌더한다. */
export function logoPng(size: number): Uint8Array {
  const hit = iconCache.get(size);
  if (hit) return hit;
  const png = new Uint8Array(
    new Resvg(logoSvg(size), {
      fitTo: { mode: "width", value: size },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng(),
  );
  iconCache.set(size, png);
  return png;
}

export function manifestJson(): string {
  return JSON.stringify(
    {
      name: SITE_NAME,
      short_name: SITE_NAME,
      description: SITE_DESCRIPTION,
      start_url: "/",
      display: "standalone",
      background_color: "#0f131d",
      theme_color: "#0f131d",
      icons: [
        { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    null,
    2,
  );
}
