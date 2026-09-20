import sanitizeHtml from "sanitize-html";

/** 본문에 허용하는 태그. writer의 md_to_html 출력 + 방어 여유분. */
const ALLOWED_TAGS = [
  "p",
  "br",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "code",
  "pre",
  "hr",
];

const EXTERNAL_LINK = /^https?:\/\//i;

/**
 * 발행 본문을 허용목록으로 정화한다.
 * script/style/이벤트 핸들러/javascript: URL은 제거되고,
 * 외부 링크에는 target="_blank" rel="noopener noreferrer"를 붙인다.
 */
export function sanitizeBodyHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? "";
        const base: Record<string, string> = {};
        if (href) base.href = href;
        if (attribs.title) base.title = attribs.title;
        if (!EXTERNAL_LINK.test(href)) return { tagName, attribs: base };
        return {
          tagName,
          attribs: { ...base, target: "_blank", rel: "noopener noreferrer" },
        };
      },
    },
  });
}

const TAG = /<[^>]*>/g;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

/** 검색용 평문 추출: 태그 제거 → 엔티티 복원 → 공백 정리 → 4000자 컷. */
export function toSearchText(html: string): string {
  const text = (html || "")
    .replace(TAG, " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 4000);
}
