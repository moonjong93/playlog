from __future__ import annotations

import json

import httpx

from writer.llm import OpenRouterChat
from writer.translate import translate_comments


def _chat(handler, **kw) -> OpenRouterChat:
    c = OpenRouterChat("https://or/api/v1", "secret", min_interval=0.0, **kw)
    c._client = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer secret"},
    )
    return c


def _reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={
        "id": "gen-tr",
        "model": "test/translate",
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 9, "cost": 0.002},
    })


COMMENTS = [
    {"author": "alice", "text": "Bill is a good pick"},
    {"author": "bob", "text": "wanted Pattinson tbh"},
]


def test_translate_success_keeps_order_and_authors():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        ko = [
            {"author": "alice", "text": "빌이 좋은 선택이다"},
            {"author": "bob", "text": "솔직히 패틴슨을 원했다"},
        ]
        return _reply("```json\n" + json.dumps(ko, ensure_ascii=False) + "\n```")

    out = translate_comments(_chat(handler), COMMENTS, model="test/translate")

    assert out == [
        {"author": "alice", "text": "빌이 좋은 선택이다"},
        {"author": "bob", "text": "솔직히 패틴슨을 원했다"},
    ]
    assert set(out[0]) == {"author", "text"}  # 원문 필드는 넣지 않는다
    body = seen["body"]
    assert body["model"] == "test/translate"
    assert "Wolverine" in body["messages"][0]["content"]        # 고유명사 규칙
    assert "Bill is a good pick" in body["messages"][1]["content"]


def test_translate_reports_usage_once():
    seen: list = []

    def handler(request):
        ko = [{"author": "alice", "text": "빌이 좋은 선택이다"},
              {"author": "bob", "text": "패틴슨을 원했다"}]
        return _reply(json.dumps(ko, ensure_ascii=False))

    translate_comments(_chat(handler), COMMENTS, model="m", on_result=seen.append)

    assert len(seen) == 1
    assert seen[0].model == "test/translate"
    assert seen[0].prompt_tokens == 7
    assert seen[0].cost_usd == 0.002


def test_translate_falls_back_on_broken_json():
    def handler(request):
        return _reply("번역 결과는 아직 JSON 이 아니다")

    assert translate_comments(_chat(handler), COMMENTS, model="m") == COMMENTS


def test_translate_falls_back_on_length_mismatch():
    def handler(request):
        return _reply(json.dumps([{"author": "alice", "text": "하나뿐"}], ensure_ascii=False))

    assert translate_comments(_chat(handler), COMMENTS, model="m") == COMMENTS


def test_translate_falls_back_on_author_mismatch():
    def handler(request):
        ko = [
            {"author": "bob", "text": "빌이 좋은 선택이다"},
            {"author": "alice", "text": "패틴슨을 원했다"},
        ]
        return _reply(json.dumps(ko, ensure_ascii=False))

    assert translate_comments(_chat(handler), COMMENTS, model="m") == COMMENTS


def test_translate_falls_back_on_http_error():
    def handler(request):
        return httpx.Response(500, json={"error": "boom"})

    assert translate_comments(_chat(handler, max_retries=0), COMMENTS, model="m") == COMMENTS


def test_translate_skips_when_every_comment_is_korean():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return _reply("[]")

    ko = [
        {"author": "김", "text": "ㅋㅋㅋ 이거 진짜 재밌다 ㅠㅠ"},
        {"author": "이", "text": "10/10"},
    ]
    assert translate_comments(_chat(handler), ko, model="m") == ko
    assert calls["n"] == 0


def test_translate_calls_when_any_comment_is_foreign():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        ko = [{"author": "김", "text": "이거 진짜 재밌다"},
              {"author": "bob", "text": "패틴슨을 원했다"}]
        return _reply(json.dumps(ko, ensure_ascii=False))

    comments = [
        {"author": "김", "text": "이거 진짜 재밌다"},
        {"author": "bob", "text": "wanted Pattinson"},
    ]
    out = translate_comments(_chat(handler), comments, model="m")

    assert calls["n"] == 1
    assert out[0] == {"author": "김", "text": "이거 진짜 재밌다"}
    assert out[1]["author"] == "bob"


def test_translate_empty_input_makes_no_call():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return _reply("[]")

    assert translate_comments(_chat(handler), [], model="m") == []
    assert calls["n"] == 0


def test_parse_array_takes_first_array_when_model_adds_commentary():
    """실측(deepseek-v4-flash-0731): 배열 + 해설 + 배열 반복. 첫 배열만 읽는다."""
    from writer.translate import _parse_array

    text = (
        '[{"author": "a", "text": "번역1"}, {"author": "b", "text": "번역2"}]\n\n'
        '"번역1"은 자연스럽다. 문장 수 유지.\n'
        '[{"author": "a", "text": "번역1"}, {"author": "b", "text": "번역2"}]'
    )
    rows = _parse_array(text)
    assert [r["text"] for r in rows] == ["번역1", "번역2"]
