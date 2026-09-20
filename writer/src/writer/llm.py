"""OpenRouter chat completions. collector 임베딩 클라이언트와 같은 재시도 패턴."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)

_RETRYABLE = {429, 500, 502, 503, 529}
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.I | re.M)


class _Retryable(Exception):
    def __init__(self, status: int, retry_after: float | None):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.retry_after = retry_after


@dataclass
class LLMResult:
    text: str
    data: dict[str, Any]
    model: str
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float | None
    request_id: str | None


def parse_json_object(text: str) -> dict[str, Any]:
    raw = _FENCE.sub("", text.strip()).strip()
    try:
        val = json.loads(raw)
        if isinstance(val, dict):
            return val
    except json.JSONDecodeError:
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        val = json.loads(raw[start : end + 1])
        if isinstance(val, dict):
            return val
    raise ValueError(f"JSON 객체를 파싱하지 못함: {text[:200]}")


def _choice_text(choice: dict) -> str:
    msg = choice.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                parts.append(str(p.get("text") or p.get("content") or ""))
        joined = "".join(parts).strip()
        if joined:
            return joined
    return ""


class OpenRouterChat:
    def __init__(self, base_url: str, api_key: str, *,
                 timeout: float = 45.0, max_retries: int = 4,
                 min_interval: float = 0.5, reasoning_effort: str = "",
                 exclude_reasoning: bool = False) -> None:
        if not api_key:
            raise RuntimeError(
                "OpenRouter 키가 필요합니다. .env 에 OPENROUTER_API_KEY= 를 넣어라"
            )
        self.base = base_url.rstrip("/")
        self.max_retries = max_retries
        self.min_interval = min_interval
        self.reasoning_effort = reasoning_effort.strip().lower()
        self.exclude_reasoning = exclude_reasoning
        self._last_request = 0.0
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "X-Title": "news-writer",
            },
        )

    def complete(self, *, model: str, system: str, user: str,
                 temperature: float, max_tokens: int,
                 strict_json: bool = True) -> LLMResult:
        data = self._complete_once(
            model, system, self._user_text(model, user), temperature, max_tokens,
        )
        choice = (data.get("choices") or [{}])[0]
        text = _choice_text(choice)
        if not text:
            reason = choice.get("finish_reason")
            usage = data.get("usage") or {}
            raise RuntimeError(
                f"빈 응답 (finish_reason={reason}, "
                f"completion_tokens={usage.get('completion_tokens')}). "
                f"모델이 서버에서 thinking 을 하다 본문을 안 남긴 것이다. "
                f"로컬 임베딩/클러스터와 무관. id={data.get('id')}"
            )
        usage = data.get("usage") or {}
        cost = usage.get("cost")
        try:
            cost_f = float(cost) if cost is not None else None
        except (TypeError, ValueError):
            cost_f = None
        parsed: dict[str, Any] = {}
        if strict_json:
            parsed = parse_json_object(text)
        else:
            try:
                parsed = parse_json_object(text)
            except (ValueError, json.JSONDecodeError):
                parsed = {}
        return LLMResult(
            text=text,
            data=parsed,
            model=data.get("model") or model,
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            cost_usd=cost_f,
            request_id=data.get("id"),
        )

    def _thinking_off(self) -> bool:
        return self.exclude_reasoning or self.reasoning_effort in ("off", "none", "disable", "disabled")

    def _user_text(self, model: str, user: str) -> str:
        # Qwen3 하이브리드는 /no_think 가 요청 필드보다 잘 먹는다(실측: effort=low 여도 생각에 2000토큰).
        if self._thinking_off() and "qwen" in model.lower() and "/no_think" not in user:
            return "/no_think\n" + user
        return user

    def _reasoning_payload(self, model: str) -> dict | None:
        if self._thinking_off():
            # Muse Spark 는 reasoning 필수. effort=none 이면 400.
            if "muse-spark" in model.lower():
                return {"exclude": True}
            return {"effort": "none", "enabled": False, "exclude": True}
        if self.reasoning_effort:
            return {"effort": self.reasoning_effort, "exclude": True}
        return None

    def _complete_once(self, model: str, system: str, user: str,
                       temperature: float, max_tokens: int) -> dict:
        body: dict = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        reasoning = self._reasoning_payload(model)
        if reasoning:
            body["reasoning"] = reasoning
        return self._post(body)

    def _post(self, body: dict) -> dict:
        for attempt in range(self.max_retries + 1):
            try:
                return self._post_once(body)
            except _Retryable as exc:
                if attempt >= self.max_retries:
                    raise RuntimeError(f"LLM 재시도 초과: {exc}") from exc
                delay = exc.retry_after if exc.retry_after is not None else min(2.0 * 2 ** attempt, 30.0)
                log.warning("OpenRouter %s — %.1f초 후 재시도 %d/%d",
                            exc, delay, attempt + 1, self.max_retries)
                time.sleep(delay)
        raise RuntimeError("LLM 재시도 초과")

    def _post_once(self, body: dict) -> dict:
        gap = self.min_interval - (time.monotonic() - self._last_request)
        if gap > 0:
            time.sleep(gap)
        resp = self._client.post(f"{self.base}/chat/completions", json=body)
        self._last_request = time.monotonic()
        if resp.status_code >= 400 and resp.status_code not in _RETRYABLE:
            raise RuntimeError(f"HTTP {resp.status_code}: {(resp.text or '')[:400]}")
        if resp.status_code in _RETRYABLE:
            raw = resp.headers.get("Retry-After")
            try:
                retry_after = float(raw) if raw else None
            except ValueError:
                retry_after = None
            raise _Retryable(resp.status_code, retry_after)
        resp.raise_for_status()
        return resp.json()

    def close(self) -> None:
        self._client.close()
