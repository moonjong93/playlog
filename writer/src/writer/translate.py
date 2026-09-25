"""커뮤니티 댓글 번역. 실패하면 원문을 그대로 돌려주고 예외를 올리지 않는다."""

from __future__ import annotations

import json
import logging
import re
from typing import Callable

from .llm import LLMResult, OpenRouterChat

log = logging.getLogger(__name__)

TRANSLATE_TEMPERATURE = 0.2
TRANSLATE_MAX_TOKENS = 16000

SYSTEM = """
당신은 해외 게임 커뮤니티 댓글을 한국어로 옮기는 번역기다. 요약하거나 설명하지 않는다.

규칙:
- 읽히는 한국어로 옮긴다. 직역하지 않는다. 번역투("~에 대해", "~하는 것을")를 피한다.
- 게임·브랜드·인물 같은 고유명사는 로마자 원문을 그대로 둔다. 예: Wolverine, GTA 6.
- 업계 약어·장르·기술 용어는 원문 표기를 그대로 둔다. 예: AAA, FPS, RPG, DLC, MMO, GPU, AI, PC. 음차하지 않는다("에이 에이 에이"✗).
- 한자·히라가나·가타카나를 쓰지 않는다.
- 원문에 없는 내용·뉴앙스·설명·이모지를 추가하지 않는다.
- 밈·속어·비속어는 톤을 살려 한국어로 옮긴다. 순화하거나 지우지 않는다.
- 문장 수와 줄바꿈을 원문과 같게 유지한다. 문장을 합치거나 나누지 않는다.
- author(닉네임)는 번역하지 않는다. 입력 문자열 그대로 돌려준다. 'u/'를 붙이지 않는다.

출력은 입력과 같은 순서의 JSON 배열 하나만:
[{"author":"...","text":"..."}]

JSON 배열만 출력한다. 설명·해설·번역 이유·다시 쓴 배열을 덧붙이지 않는다.
""".strip()

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.I | re.M)
_HANGUL = re.compile(r"[\uac00-\ud7a3\u1100-\u11ff\u3131-\u318e]")


def _is_korean_only(text: str) -> bool:
    """한글·숫자·문장부호·공백뿐이면 True. 라틴/한자/가나는 False."""
    return all(not (ch.isalpha() and not _HANGUL.match(ch)) for ch in (text or ""))


def _parse_array(text: str) -> list:
    """첫 번째 JSON 배열만 집는다.

    모델이 배열 뒤에 해설을 붙이거나 배열을 반복해도(실측: deepseek-v4-flash-0731)
    첫 배열만 읽으면 되므로 raw_decode 로 정확히 잘라낸다.
    """
    raw = _FENCE.sub("", (text or "").strip()).strip()
    start = raw.find("[")
    if start < 0:
        return []
    try:
        val, _end = json.JSONDecoder().raw_decode(raw[start:])
    except json.JSONDecodeError:
        return []
    return val if isinstance(val, list) else []


def _user_text(comments: list[dict]) -> str:
    return (
        f"댓글 {len(comments)}개:\n"
        + json.dumps(comments, ensure_ascii=False)
        + "\n\n같은 순서·같은 author로 한국어 번역한 JSON 배열만 출력해라."
    )


def translate_comments(chat: OpenRouterChat, comments: list[dict], *, model: str,
                       temperature: float = TRANSLATE_TEMPERATURE,
                       max_tokens: int = TRANSLATE_MAX_TOKENS,
                       on_result: Callable[[LLMResult], None] | None = None) -> list[dict]:
    """댓글(소스당 최대 6개)을 한국어로 옮긴다.

    개수·author 가 입력과 다르거나 JSON 파싱이 실패하면 **원문을 그대로** 돌려준다.
    호출 오류도 같다(예외를 올리지 않는다). 이미 한국어뿐이면 호출을 건너뛴다.
    on_result 는 호출이 성공했을 때 사용량 기록용으로 부른다(실패해도 번역은 계속).
    """
    original = [
        {"author": str(c.get("author") or ""), "text": str(c.get("text") or "")}
        for c in comments
        if isinstance(c, dict)
    ]
    if not original:
        return []
    if all(_is_korean_only(c["text"]) for c in original):
        return original

    try:
        result = chat.complete(
            model=model, system=SYSTEM, user=_user_text(original),
            temperature=temperature, max_tokens=max_tokens, strict_json=False,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("댓글 번역 실패(호출) — 원문 유지: %s", exc)
        return original

    if on_result is not None:
        try:
            on_result(result)
        except Exception as exc:  # noqa: BLE001
            log.warning("댓글 번역 사용량 기록 실패: %s", exc)

    rows = _parse_array(result.text)
    if len(rows) != len(original):
        log.warning("댓글 번역 실패(개수 %d≠%d) — 원문 유지", len(rows), len(original))
        return original
    out = []
    for src, row in zip(original, rows):
        if not isinstance(row, dict):
            log.warning("댓글 번역 실패(형식) — 원문 유지")
            return original
        author = str(row.get("author") or "").strip()
        text = str(row.get("text") or "").strip()
        if author != src["author"] or not text:
            log.warning("댓글 번역 실패(author/본문 불일치) — 원문 유지")
            return original
        out.append({"author": src["author"], "text": text})
    return out
