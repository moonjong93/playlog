"""HTTP 전송 계층.

두 가지 함정을 모두 처리해야 한다(실측):
  · Eurogamer 등 → 봇 UA 차단      ⇒ 브라우저 UA 를 기본으로
  · Reddit      → Python httpx 의 TLS 지문 차단(403/429)
                   curl 은 통과, curl_cffi impersonate='safari' 도 통과
                   ⇒ 피드별로 impersonate 를 지정하면 curl_cffi 로 우회
"""

from __future__ import annotations

import logging
import time

import httpx

log = logging.getLogger(__name__)


class Response:
    """httpx.Response 중 우리가 쓰는 부분만 맞춘 얇은 포장."""

    def __init__(self, status_code: int, content: bytes, headers: dict):
        self.status_code = status_code
        self.content = content
        self.headers = headers

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"Client error '{self.status_code}' for url", request=None, response=None  # type: ignore[arg-type]
            )


class FeedFetcher:
    def __init__(
        self,
        client: httpx.Client,
        impersonate: str | None = None,
        retries: int = 2,
        retry_sleep: float = 25.0,
    ) -> None:
        self.client = client
        self.impersonate = impersonate
        self.retries = retries
        self.retry_sleep = retry_sleep

    def get(self, url: str, headers: dict | None = None, timeout: float | None = None):
        if not self.impersonate:
            return self.client.get(url, headers=headers, timeout=timeout)

        from curl_cffi import requests as ccr  # 무지연 import

        status = 0
        body = b""
        hdrs: dict = {}
        for attempt in range(self.retries + 1):
            r = ccr.get(
                url,
                impersonate=self.impersonate,
                headers=headers or {},
                timeout=timeout or 30,
                allow_redirects=True,
            )
            status = r.status_code
            body, hdrs = r.content, dict(r.headers)
            # 429 는 재시도해도 같은 창에서 또 막힌다. 헤더를 남겨 서킷브레이커가 보게 한다.
            if status != 403:
                return Response(status, body, hdrs)
            if attempt < self.retries:
                log.warning(
                    "%s → HTTP %s (지문). %.0f초 후 재시도 %d/%d",
                    url.split("?")[0], status, self.retry_sleep, attempt + 1, self.retries,
                )
                time.sleep(self.retry_sleep)
        return Response(status, body, hdrs)
