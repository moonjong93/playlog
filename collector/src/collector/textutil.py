"""텍스트 유틸: RSS description 에서 HTML 제거, 제목 정규화."""

from __future__ import annotations

import html
import re
import unicodedata

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)


def strip_html(value: str | None, limit: int | None = 2000) -> str:
    if not value:
        return ""
    text = _SCRIPT_RE.sub(" ", value)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text).strip()
    if limit is not None and len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def normalize_title(title: str | None) -> str:
    """유사도 비교용 제목 정규화(소문자/구두점 제거)."""
    if not title:
        return ""
    t = unicodedata.normalize("NFKC", title).lower()
    t = re.sub(r"[\u2018\u2019\u201c\u201d]", "", t)
    t = re.sub(r"[^0-9a-z\uac00-\ud7a3 ]+", " ", t)
    return _WS_RE.sub(" ", t).strip()
