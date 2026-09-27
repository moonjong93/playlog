import { env } from "./env.ts";

export const SITE_NAME = "PLAYLOG";
export const SITE_TAGLINE = "게임 뉴스 & 스토리";
export const SITE_DESCRIPTION =
  "게임 업계 뉴스와 해외 매체·커뮤니티 반응을 매일 한국어로 요약해 전하는 게임 뉴스 & 스토리. 원문 출처와 태그로 관심 주제만 골라 읽습니다.";
export const SITE_ALTERNATE_NAME = "플레이로그";
export const DEFAULT_OG_PATH = "/og/default.png";

/** 문의·법적 요청 수신 주소. 푸터와 안내 페이지가 함께 쓴다. */
export const SITE_CONTACT_EMAIL = "support.news@nevra.app";

/** 안내·법적 문서의 시행일 표기. */
export const LEGAL_EFFECTIVE_DATE = "2026년 9월 26일";

/** 검색 결과 등 색인하면 안 되는 페이지의 robots 값. */
export const NOINDEX = "noindex, follow";

/** 기본 robots 값. 큰 이미지 미리보기와 긴 스니펫을 허용한다. */
export const ROBOTS_DEFAULT = "max-image-preview:large, max-snippet:-1, max-video-preview:-1";

/** 절대 URL 기준. SITE_URL이 없으면 요청 origin을 넘겨받는다. */
export function absoluteUrl(path: string, origin = env.siteUrl): string {
  const base = origin.replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

/** JSON-LD는 `</script>`로 조기 종료되지 않게 `<`를 이스케이프한다. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
