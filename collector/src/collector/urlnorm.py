"""URL 정규화 + 해시.

Collector의 중복 제거는 전부 여기 규칙에 의존한다.
규칙을 바꾸면 기존 raw_items 와 중복이 생길 수 있으니 신중히 변경할 것.
"""

from __future__ import annotations

import hashlib
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# 추적용 파라미터(제거 대상)
_TRACKING_PARAMS = {
    "fbclid",
    "gclid",
    "dclid",
    "msclkid",
    "yclid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "_hsenc",
    "_hsmi",
    "hsctatracking",
    "ref",
    "ref_src",
    "referrer",
    "source",
    "spm",
    "cmpid",
    "cmp",
    "CMP",
    "at_medium",
    "at_campaign",
    "share_id",
    "sh",
    "__twitter_impression",
    "guccounter",
    "guce_referrer",
    "guce_referrer_sig",
}

# 접두사로 걸러내는 파라미터 (utm_* 등)
_TRACKING_PREFIXES = ("utm_", "pk_", "piwik_", "mtm_", "hsa_")


def _is_tracking(key: str) -> bool:
    k = key.lower()
    return k in _TRACKING_PARAMS or k.startswith(_TRACKING_PREFIXES)


def canonicalize(url: str) -> str:
    """중복 판단용 canonical URL.

    - scheme/host 소문자화, 기본 포트 제거
    - fragment 제거
    - 추적 파라미터 제거, 나머지 쿼리는 정렬
    - 중복 슬래시 정리, 루트가 아닌 끝 슬래시 제거
    """
    url = (url or "").strip()
    if not url:
        return ""

    parts = urlsplit(url)
    scheme = parts.scheme.lower() or "https"
    netloc = parts.netloc.lower()

    if scheme == "http" and netloc.endswith(":80"):
        netloc = netloc[:-3]
    elif scheme == "https" and netloc.endswith(":443"):
        netloc = netloc[:-4]

    path = parts.path or "/"
    while "//" in path:
        path = path.replace("//", "/")
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/") or "/"

    pairs = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(k)]
    pairs.sort()
    query = urlencode(pairs, doseq=True)

    return urlunsplit((scheme, netloc, path, query, ""))


def url_hash(url: str) -> str:
    """canonical URL 기준 sha256. raw_items.url_hash 에 저장한다."""
    return hashlib.sha256(canonicalize(url).encode("utf-8")).hexdigest()


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()
