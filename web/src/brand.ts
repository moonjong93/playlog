import { Resvg } from "@resvg/resvg-js";

/**
 * 사이트 로고 마크(터미널 `>_`). 폰트 없이 그려지므로 favicon·앱 아이콘
 * 어디서든 같은 모양이 나온다.
 */
const MARK = `<rect x="5" y="5" width="54" height="54" rx="11" fill="#1c1f2a" stroke="#464554" stroke-width="3"/>
<path d="M22 21.5 L32 32 L22 42.5" fill="none" stroke="#c0c1ff" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M36.5 42.5 H46" fill="none" stroke="#c0c1ff" stroke-width="6.5" stroke-linecap="round"/>`;

export function logoSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${MARK}</svg>`;
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
      name: "Ludus Digest",
      short_name: "Ludus Digest",
      description: "게임 업계 뉴스와 해외 커뮤니티 반응을 매일 한국어로 요약한 다이제스트.",
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
