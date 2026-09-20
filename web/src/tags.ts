/** 자유 태그 정규화와 레거시 섹션 매핑. writer의 publish.py와 같은 규칙을 쓴다. */

/** 저장 시 방어 상한. writer는 기사당 3개까지 낸다. */
export const MAX_TAGS = 5;
export const TAG_MAX_LEN = 20;
export const TAGS_PAGE_SIZE = 30;

/** v3 이전 section enum → 한글 태그. */
export const LEGACY_SECTION_TAGS: Record<string, string> = {
  industry: "업계·사업",
  announce: "발표·신작",
  ship: "출시·패치",
  talk: "발언",
  review: "리뷰·공략",
};

/** 허용 문자: 한글/영문/숫자/공백/·/+/-/&/_/./: (`/`는 문자열 입력에서 구분자다) */
const DISALLOWED = /[^\p{Script=Hangul}A-Za-z0-9 ·+&_.:-]/gu;

function cleanTag(raw: string): string {
  const filtered = raw
    .trim()
    .replace(/^#+/, "")
    .replace(DISALLOWED, "")
    .replace(/\s+/g, " ")
    .trim();
  return filtered.slice(0, TAG_MAX_LEN).trim();
}

/**
 * 태그 입력을 정규화한다.
 * 문자열이면 쉼표/슬래시로 나누고, 배열이 아니면 빈 배열이다.
 * 2자 미만은 버리고, 대소문자 무시 중복은 먼저 나온 표기를 남긴다. 최대 5개.
 */
export function normalizeTags(value: unknown): string[] {
  const items =
    typeof value === "string"
      ? value.split(/[,\/]/)
      : Array.isArray(value)
        ? value
        : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") continue;
    const tag = cleanTag(item);
    if (tag.length < 2) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
