from __future__ import annotations

import json

import httpx
import pytest

from writer.agents import run_writer
from writer.llm import OpenRouterChat, parse_json_object


def _chat(handler, **kw) -> OpenRouterChat:
    c = OpenRouterChat("https://or/api/v1", "secret", min_interval=0.0, **kw)
    c._client = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer secret"},
    )
    return c


def _ok(payload: dict, model="test/writer"):
    return httpx.Response(200, json={
        "id": "gen-1",
        "model": model,
        "choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "cost": 0.001},
    })


def test_parse_json_with_fence():
    d = parse_json_object("```json\n{\"title_ko\": \"안녕\"}\n```")
    assert d["title_ko"] == "안녕"


def test_parse_json_embedded():
    d = parse_json_object("여기 결과입니다.\n{\"a\": 1, \"b\": 2}\n끝")
    assert d == {"a": 1, "b": 2}


def test_retries_on_429_then_succeeds():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "slow"})
        return _ok({"title_ko": "제목", "lede_ko": "리드", "body_md": "본문"})

    r = _chat(handler, max_retries=2).complete(
        model="m", system="s", user="u", temperature=0.2, max_tokens=100,
    )
    assert calls["n"] == 2
    assert r.data["title_ko"] == "제목"
    assert r.prompt_tokens == 10
    assert r.cost_usd == 0.001


def test_gives_up_after_max_retries():
    def handler(request):
        return httpx.Response(429, headers={"Retry-After": "0"})

    with pytest.raises(RuntimeError, match="재시도 초과"):
        _chat(handler, max_retries=1).complete(
            model="m", system="s", user="u", temperature=0.1, max_tokens=10,
        )


def test_writer_agent_fills_pack():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _ok({"title_ko": "T", "lede_ko": "L", "body_md": "B"})

    prompts = {
        "writer": {
            "system": "sys",
            "user": "팩:\n{pack}",
        }
    }
    r = run_writer(_chat(handler), prompts, "소스팩내용", model="m", temperature=0.2, max_tokens=50)
    assert "소스팩내용" in seen["body"]["messages"][1]["content"]
    assert r.data["body_md"] == "B"


def test_exclude_reasoning_flag():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _ok({"title_ko": "T", "lede_ko": "L", "body_md": "B"})

    _chat(handler, exclude_reasoning=True).complete(
        model="qwen/qwen3.7-flash", system="s", user="u", temperature=0.2, max_tokens=100,
    )
    assert seen["body"]["reasoning"] == {"effort": "none", "enabled": False, "exclude": True}
    assert seen["body"]["messages"][1]["content"].startswith("/no_think\n")


def test_muse_spark_keeps_reasoning_on():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _ok({"title_ko": "T", "lede_ko": "L", "body_md": "B"})

    _chat(handler, reasoning_effort="none").complete(
        model="meta/muse-spark-1.3-contributor", system="s", user="u",
        temperature=0.2, max_tokens=100,
    )
    assert seen["body"]["reasoning"] == {"exclude": True}
    assert "effort" not in seen["body"]["reasoning"]


def test_no_think_only_on_qwen_when_off():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _ok({"title_ko": "T", "lede_ko": "L", "body_md": "B"})

    _chat(handler, reasoning_effort="none").complete(
        model="mistralai/mistral-nemo", system="s", user="원문", temperature=0.2, max_tokens=100,
    )
    assert seen["body"]["messages"][1]["content"] == "원문"
    assert seen["body"]["reasoning"]["effort"] == "none"


def test_does_not_send_reasoning_by_default():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return _ok({"title_ko": "T", "lede_ko": "L", "body_md": "B"})

    _chat(handler).complete(model="z-ai/glm-5.3-flashx", system="s", user="u",
                            temperature=0.2, max_tokens=100)
    assert "reasoning" not in seen["body"]


def test_empty_length_fails_fast():
    def handler(request):
        return httpx.Response(200, json={
            "id": "gen-empty",
            "model": "z-ai/glm-5.3-flashx",
            "choices": [{"finish_reason": "length", "message": {"content": ""}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 1800},
        })

    with pytest.raises(RuntimeError, match="빈 응답"):
        _chat(handler).complete(model="m", system="s", user="u", temperature=0.2, max_tokens=1800)


def test_auth_header():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return _ok({"title_ko": "T", "lede_ko": "L", "body_md": "B"})

    _chat(handler).complete(model="m", system="s", user="u", temperature=0, max_tokens=10)
    assert seen["auth"] == "Bearer secret"
