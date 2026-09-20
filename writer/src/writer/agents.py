"""Writer / Editor 역할. OpenRouter 호출과 프롬프트만 담당한다."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml

from .llm import LLMResult, OpenRouterChat


def load_prompts(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise RuntimeError(f"프롬프트 파일이 맵이 아니다: {path}")
    return data


def prompt_version(path: Path) -> str:
    raw = path.read_text(encoding="utf-8").encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:12]


def _fill(template: str, **kwargs: str) -> str:
    out = template
    for k, v in kwargs.items():
        out = out.replace("{" + k + "}", v)
    return out


def run_writer(chat: OpenRouterChat, prompts: dict, pack: str, *,
               model: str, temperature: float, max_tokens: int) -> LLMResult:
    spec = prompts["writer"]
    return chat.complete(
        model=model,
        system=spec["system"].strip(),
        user=_fill(spec["user"], pack=pack).strip(),
        temperature=temperature,
        max_tokens=max_tokens,
    )
