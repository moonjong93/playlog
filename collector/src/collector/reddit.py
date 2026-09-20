"""Reddit RSS 접근.

공식 Data API 는 2026 Responsible Builder Policy 로 신규 앱이 막혀 있다.
익명 .rss 는 IP 당 대략 1 req/min (실측: 첫 요청만 200, 이후 429).

대신 reddit.com/prefs/feeds 의 user= / feed= 를 **모든 공개 .rss URL** 에 붙인다.
(upvoted.rss 같은 개인 피드 자체가 아니라, 그 URL 에 붙은 두 파라미터가 인증 토큰이다.)
"""

from __future__ import annotations

import logging
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .fetcher import FeedFetcher, Response

log = logging.getLogger(__name__)


class RateLimitError(Exception):
    """Reddit 이 429 를 줬거나 서킷브레이커가 열려 있다."""


def is_reddit_url(url: str) -> bool:
    host = urlsplit(url).netloc.lower()
    return host == "reddit.com" or host.endswith(".reddit.com")


def with_reddit_auth(url: str, user: str = "", feed: str = "") -> str:
    """기존 쿼리를 유지한 채 user=/feed= 를 붙인다. 값이 없으면 URL 그대로."""
    if not user or not feed or not is_reddit_url(url):
        return url
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["user"] = user
    query["feed"] = feed
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def rss_first(sources) -> list:
    """Reddit 429 가 다른 RSS 를 막지 않게, 일반 피드를 먼저 돌린다."""
    other = [s for s in sources if not is_reddit_url(s["feed_url"])]
    reddit = [s for s in sources if is_reddit_url(s["feed_url"])]
    return other + reddit


def _header(headers: dict, name: str) -> str | None:
    lower = name.lower()
    for k, v in (headers or {}).items():
        if str(k).lower() == lower:
            return str(v)
    return None


def _float_header(headers: dict, name: str) -> float | None:
    raw = _header(headers, name)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


class RedditGate:
    """Reddit 요청 전역 한도 + 429 서킷브레이커.

    인증 RSS 는 익명 1/min 보다 헐겁다(실측: 연속 4회 200).
    그래도 한 번 429 가 나면 남은 Reddit 요청은 이번 사이클에서 접는다.
    """

    def __init__(self, min_interval: float = 20.0) -> None:
        self.min_interval = max(0.0, min_interval)
        self._next_ok = 0.0
        self.blocked_until = 0.0

    @property
    def blocked(self) -> bool:
        return time.monotonic() < self.blocked_until

    def wait(self) -> None:
        now = time.monotonic()
        delay = max(self._next_ok, self.blocked_until) - now
        if delay > 0:
            log.info("Reddit 대기 %.0fs", delay)
            time.sleep(delay)
        self._next_ok = time.monotonic() + self.min_interval

    def observe(self, resp) -> None:
        headers = dict(getattr(resp, "headers", None) or {})
        status = int(getattr(resp, "status_code", 0) or 0)
        retry = _float_header(headers, "Retry-After")
        remaining = _float_header(headers, "x-ratelimit-remaining")
        reset = _float_header(headers, "x-ratelimit-reset")

        wait = 0.0
        if status in (403, 429):
            wait = retry or reset or 120.0
        elif remaining is not None and remaining <= 0:
            wait = retry or reset or self.min_interval or 60.0
        if wait > 0:
            self.blocked_until = max(self.blocked_until, time.monotonic() + wait)
            self._next_ok = max(self._next_ok, self.blocked_until)
            log.warning("Reddit 서킷브레이커 %.0fs (http=%s)", wait, status)


class GatedFetcher:
    """인증 쿼리를 붙이고, 요청 전에 게이트를 통과한다."""

    def __init__(self, inner: FeedFetcher, gate: RedditGate, user: str = "", feed: str = "") -> None:
        self.inner = inner
        self.gate = gate
        self.user = user
        self.feed = feed

    def get(self, url: str, headers: dict | None = None, timeout: float | None = None) -> Response:
        if self.gate.blocked:
            raise RateLimitError("reddit circuit open")
        url = with_reddit_auth(url, self.user, self.feed)
        self.gate.wait()
        resp = self.inner.get(url, headers=headers, timeout=timeout)
        self.gate.observe(resp)
        if resp.status_code == 429:
            raise RateLimitError("HTTP 429")
        return resp
