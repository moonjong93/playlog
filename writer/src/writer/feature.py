"""수동 특집 기사 → 웹 ingest.

자동 파이프라인(story) 밖의 장문 특집용이다. `writer feature --file 글.md` 로 발행한다.
파일 = YAML front matter + 마크다운 본문(제목·인용·목록·굵게·링크 지원).

    ---
    slug: pubg-asia-stars-2026
    title: 제목
    lede: |
      첫 줄
      둘째 줄
    tags: [특집, PUBG]
    sources:
      - name: 연합뉴스
        url: https://...
        role: news
    ---
    ## 소제목
    본문
"""

from __future__ import annotations

import html
import logging
import re
from pathlib import Path

import httpx
import yaml

from .publish import normalize_tags, post_article, unescape_newlines

log = logging.getLogger(__name__)

FM_DELIM = "---"

_H2 = re.compile(r"^##\s+(.+)$")
_H3 = re.compile(r"^###\s+(.+)$")
_UL = re.compile(r"^[-*]\s+(.+)$")
_OL = re.compile(r"^\d+[.)]\s+(.+)$")
_HR = re.compile(r"^-{3,}$")
_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"\*([^*]+)\*")


class FeatureError(ValueError):
    """특집 원고 파일이 계약(front matter)에 맞지 않는다."""


def _iso(value: object) -> str:
    """YAML이 datetime으로 파싱한 값도 문자열 ISO로 만든다."""
    if hasattr(value, "isoformat"):
        return str(value.isoformat())  # type: ignore[union-attr]
    return str(value or "").strip()


def load_feature(path: Path) -> dict:
    """front matter + 본문 마크다운을 읽는다. slug/title/본문은 필수."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise FeatureError(f"파일을 읽을 수 없다: {exc}") from exc
    lines = text.splitlines()
    if not lines or lines[0].strip() != FM_DELIM:
        raise FeatureError("front matter(첫 줄 ---)로 시작해야 한다")
    try:
        end = next(i for i, line in enumerate(lines[1:], 1) if line.strip() == FM_DELIM)
    except StopIteration:
        raise FeatureError("front matter를 닫는 --- 가 없다") from None
    meta = yaml.safe_load("\n".join(lines[1:end])) or {}
    if not isinstance(meta, dict):
        raise FeatureError("front matter는 YAML 매핑이어야 한다")
    body_md = "\n".join(lines[end + 1:]).strip()
    slug = str(meta.get("slug") or "").strip()
    title = str(meta.get("title") or "").strip()
    if not slug:
        raise FeatureError("slug 가 없다")
    if not title:
        raise FeatureError("title 이 없다")
    if not body_md:
        raise FeatureError("본문이 비었다")
    doc = dict(meta)
    doc.update(slug=slug, title=title, body_md=body_md)
    return doc


def _inline(text: str) -> str:
    """문단/목록 안의 인라인 마크다운. HTML 은 먼저 이스케이프한다."""
    out = html.escape(text, quote=False)
    out = _LINK.sub(lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', out)
    out = _BOLD.sub(r"<strong>\1</strong>", out)
    return _ITALIC.sub(r"<em>\1</em>", out)


def feature_md_to_html(md: str) -> str:
    """특집 본문용 마크다운 일부 변환: ##/###, 인용, 목록, hr, 굵게/기울임/링크.

    자동 기사용 `publish.md_to_html` 과 달리 제목·인용·목록을 살린다(웹 sanitize 허용 태그).
    """
    blocks: list[str] = []
    para: list[str] = []
    quote: list[str] = []
    items: list[str] = []
    list_tag: str | None = None

    def flush_para() -> None:
        if para:
            blocks.append(f"<p>{'<br>\n'.join(_inline(line) for line in para)}</p>")
            para.clear()

    def flush_quote() -> None:
        if quote:
            blocks.append(
                f"<blockquote>{'<br>\n'.join(_inline(line) for line in quote)}</blockquote>"
            )
            quote.clear()

    def flush_list() -> None:
        nonlocal list_tag
        if items and list_tag:
            body = "\n".join(f"<li>{_inline(item)}</li>" for item in items)
            blocks.append(f"<{list_tag}>{body}</{list_tag}>")
        items.clear()
        list_tag = None

    for raw in (md or "").splitlines():
        line = raw.strip()
        if not line:
            flush_para()
            flush_quote()
            flush_list()
            continue
        if _HR.match(line):
            flush_para()
            flush_quote()
            flush_list()
            blocks.append("<hr>")
            continue
        m = _H3.match(line)
        if m:
            flush_para()
            flush_quote()
            flush_list()
            blocks.append(f"<h3>{_inline(m.group(1))}</h3>")
            continue
        m = _H2.match(line)
        if m:
            flush_para()
            flush_quote()
            flush_list()
            blocks.append(f"<h2>{_inline(m.group(1))}</h2>")
            continue
        if line.startswith(">"):
            flush_para()
            flush_list()
            quote.append(line.lstrip(">").strip())
            continue
        m = _UL.match(line)
        if m:
            flush_para()
            flush_quote()
            if list_tag not in (None, "ul"):
                flush_list()
            list_tag = "ul"
            items.append(m.group(1))
            continue
        m = _OL.match(line)
        if m:
            flush_para()
            flush_quote()
            if list_tag not in (None, "ol"):
                flush_list()
            list_tag = "ol"
            items.append(m.group(1))
            continue
        flush_quote()
        flush_list()
        para.append(line)

    flush_para()
    flush_quote()
    flush_list()
    return "\n".join(blocks)


def feature_payload(doc: dict, *, published_at: str, updated_at: str) -> dict:
    """웹 `POST /internal/articles` payload. story_id 는 없다(수동 원고)."""
    tags = normalize_tags(doc.get("tags")) if "tags" in doc else None
    sources: list[dict] = []
    for item in doc.get("sources") or []:
        if not isinstance(item, dict):
            continue
        sources.append({
            "name": str(item.get("name") or ""),
            "url": str(item.get("url") or ""),
            "role": str(item.get("role") or ""),
        })
    payload = {
        "slug": doc["slug"],
        "title_ko": doc["title"],
        "lede_ko": unescape_newlines(str(doc.get("lede") or "")).strip(),
        "body_html": feature_md_to_html(doc["body_md"]),
        "published_at": _iso(doc.get("published_at")) or published_at,
        "updated_at": updated_at,
        "sources": sources,
        "story_id": None,
    }
    if tags is not None:
        payload["tags"] = tags
    return payload


def publish_feature(doc: dict, *, base_url: str, api_key: str,
                    published_at: str, updated_at: str,
                    client: httpx.Client | None = None) -> int:
    """원고를 웹에 발행한다. HTTP 200(수정)/201(신규)을 돌려준다."""
    payload = feature_payload(doc, published_at=published_at, updated_at=updated_at)
    return post_article(base_url, api_key, payload, client=client)
