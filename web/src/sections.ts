/** 기사 섹션 enum, 한글 라벨, 탭 순서. */

export const SECTIONS = ["industry", "announce", "ship", "talk", "review"] as const;

export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  industry: "업계·사업",
  announce: "발표·신작",
  ship: "출시·패치",
  talk: "발언",
  review: "리뷰·공략",
};

export function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value);
}

/** 화이트리스트 밖이면 빈 문자열. */
export function normalizeSection(value: string): string {
  const trimmed = value.trim();
  return isSection(trimmed) ? trimmed : "";
}

export function sectionLabel(value: string): string | null {
  return isSection(value) ? SECTION_LABELS[value] : null;
}
