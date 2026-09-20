from __future__ import annotations

import json

import httpx
import pytest

from writer.llm import OpenRouterChat
from writer.pipeline import build_prepared, persist_prepared, run_once, write_story
from writer.agents import load_prompts, prompt_version
from writer.store import advance_intake, get_intake_after_id

from conftest import MODEL, PROMPTS, add_item, add_source, make_settings, v


def _chat(handler) -> OpenRouterChat:
    c = OpenRouterChat("https://or/api/v1", "secret", min_interval=0.0)
    c._client = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer secret"},
    )
    return c


def _llm_reply(content: str, *, model: str = "test/writer") -> httpx.Response:
    return httpx.Response(200, json={
        "id": "gen-1",
        "model": model,
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 8},
    })


def _handler(calls: dict, translate):
    """writer 호출과 번역 호출을 요청 모양으로 구분한다(번역 요청만 댓글 JSON 을 싣는다)."""

    def handler(request):
        body = json.loads(request.content)
        user = body["messages"][1]["content"]
        if '"author"' in user:
            calls["translate"] += 1
            return _llm_reply(translate(calls["translate"]), model="test/translate")
        calls["writer"] += 1
        article = {"title_ko": "공식 출시", "lede_ko": "오늘 나왔다.", "body_md": "본문이다."}
        return _llm_reply(json.dumps(article, ensure_ascii=False))

    return handler


def _story_with_comments(conn, s, comments: list[dict]) -> int:
    """시드 1 + 레딧 댓글이 붙은 스토리를 만들어 id 를 돌려준다."""
    ign = add_source(conn, "IGN", weight=1.5)
    add_item(conn, ign, "Official launch", desc="x" * 250, vec=v(1, 0, 0, 0))
    reddit = add_source(conn, "Reddit r/Games", kind="community", weight=0.8)
    add_item(
        conn, reddit, "Reddit thread", desc="레딧 글", vec=v(0.99, 0.1, 0, 0),
        content=json.dumps({"post_title": "t", "comments": comments}, ensure_ascii=False),
    )
    run_once(conn, s, write=False)
    return conn.execute("SELECT id FROM stories").fetchone()["id"]


def _capture_payloads(monkeypatch) -> list[dict]:
    sent: list[dict] = []
    monkeypatch.setattr(
        "writer.pipeline.post_article", lambda url, key, payload: sent.append(payload) or 201
    )
    return sent


def _community_comments(payload: dict) -> list[dict]:
    src = [s for s in payload["sources"] if s["role"] == "community"][0]
    return src["comments"]


def test_persist_claims_items_so_second_run_is_empty(conn, tmp_path):
    ign = add_source(conn, "IGN")
    gem = add_source(conn, "Gematsu")
    add_item(conn, ign, "Shape of Dreams launches", desc="x" * 250, vec=v(1, 0, 0, 0))
    add_item(conn, gem, "Shape of Dreams out now", desc="x" * 250, vec=v(0.98, 0.1, 0, 0))
    s = make_settings(tmp_path)
    cands, prepared = build_prepared(conn, s)
    assert len(prepared) == 1
    assert prepared[0].decision == "write"
    persist_prepared(conn, s, prepared, run_id=None)
    advance_intake(conn, [c.id for c in cands])
    claimed = conn.execute("SELECT COUNT(*) c FROM writing_items").fetchone()["c"]
    assert claimed == 2
    stories = conn.execute("SELECT status, source_count FROM stories").fetchone()
    assert stories["status"] == "clustered"
    assert stories["source_count"] == 2
    _, prepared2 = build_prepared(conn, s)
    assert prepared2 == []


def test_thin_singleton_is_skipped_with_reason(conn, tmp_path):
    """발췌가 짧은 소스는 재료로 보지 않는다(새 기준)."""
    a = add_source(conn, "PC Gamer")
    add_item(conn, a, "Tiny blurb", desc="60 chars", vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path)
    stats = run_once(conn, s, write=False)
    row = conn.execute("SELECT status, skip_reason FROM stories").fetchone()
    assert row["status"] == "skipped"
    assert row["skip_reason"] == "재료부족"
    assert stats["stories_new"] == 1


def test_merge_attaches_to_existing_story(conn, tmp_path):
    ign = add_source(conn, "IGN")
    gem = add_source(conn, "Gematsu")
    add_item(conn, ign, "First", desc="x" * 250, vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path)
    run_once(conn, s, write=False)
    sid = conn.execute("SELECT id FROM stories").fetchone()["id"]
    assert conn.execute("SELECT status FROM stories").fetchone()["status"] == "clustered"
    add_item(conn, gem, "Follow-up", desc="y" * 250, vec=v(0.99, 0.05, 0, 0))
    run_once(conn, s, write=False)
    n = conn.execute("SELECT COUNT(*) c FROM stories").fetchone()["c"]
    assert n == 1
    src = conn.execute("SELECT COUNT(*) c FROM story_sources WHERE story_id=?", (sid,)).fetchone()["c"]
    assert src == 2
    st = conn.execute("SELECT status, source_count FROM stories WHERE id=?", (sid,)).fetchone()
    assert st["source_count"] == 2
    assert st["status"] == "clustered"


def test_write_story_publishes_markdown(conn, tmp_path):
    ign = add_source(conn, "IGN", weight=1.5)
    add_item(conn, ign, "Official launch", desc="x" * 250, vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path)
    run_once(conn, s, write=False)
    sid = conn.execute("SELECT id FROM stories").fetchone()["id"]
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        payload = {"title_ko": "공식 출시", "lede_ko": "오늘 나왔다.", "body_md": "본문이다."}
        return httpx.Response(200, json={
            "id": f"gen-{calls['n']}",
            "model": "test/writer",
            "choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 8},
        })

    chat = _chat(handler)
    path = write_story(
        conn, s, chat, story_id=sid, run_id=None,
        prompts=load_prompts(PROMPTS), pver=prompt_version(PROMPTS),
    )
    assert path is not None and path.exists()
    text = path.read_text(encoding="utf-8")
    assert "공식 출시" in text
    assert "본문이다" in text
    st = conn.execute("SELECT status, title_ko FROM stories WHERE id=?", (sid,)).fetchone()
    assert st["status"] == "published"
    assert st["title_ko"] == "공식 출시"
    stages = [r["stage"] for r in conn.execute("SELECT stage FROM articles ORDER BY id")]
    assert stages == ["written"]
    roles = [r["role"] for r in conn.execute("SELECT role FROM llm_usage ORDER BY id")]
    assert roles == ["writer"]
    assert calls["n"] == 1


def test_write_story_sends_tags_and_republish_omits_them(conn, tmp_path, monkeypatch):
    ign = add_source(conn, "IGN", weight=1.5)
    add_item(conn, ign, "Official launch", desc="x" * 250, vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path, web_url="https://web.example", web_api_key="k")
    run_once(conn, s, write=False)
    sid = conn.execute("SELECT id FROM stories").fetchone()["id"]

    def handler(request):
        payload = {
            "title_ko": "공식 출시", "lede_ko": "오늘 나왔다.", "body_md": "본문이다.",
            "tags": ["닌텐도", "닌텐도", "#TGS2026!!", "가"],
        }
        return httpx.Response(200, json={
            "id": "gen-1",
            "model": "test/writer",
            "choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 8},
        })

    sent: list[dict] = []
    monkeypatch.setattr("writer.pipeline.post_article", lambda url, key, payload: sent.append(payload) or 201)
    chat = _chat(handler)
    prompts, pver = load_prompts(PROMPTS), prompt_version(PROMPTS)

    path = write_story(conn, s, chat, story_id=sid, run_id=None, prompts=prompts, pver=pver)
    assert sent[0]["tags"] == ["닌텐도", "TGS2026"]
    assert "tags: [닌텐도, TGS2026]" in path.read_text(encoding="utf-8")

    write_story(conn, s, chat, story_id=sid, run_id=None, prompts=prompts, pver=pver)
    assert len(sent) == 2
    assert "tags" not in sent[1]  # 재발행: 웹이 기존 태그를 유지한다


def test_community_only_story_is_skipped(conn, tmp_path):
    """시드를 잃고 레딧 글만 남은 스토리는 기사로 쓰지 않는다(LLM 호출도 하지 않는다)."""
    ign = add_source(conn, "IGN", weight=1.5)
    reddit = add_source(conn, "Reddit", kind="community", weight=0.8)
    add_item(conn, ign, "Seed article", desc="x" * 250, vec=v(1, 0, 0, 0))
    add_item(
        conn, reddit, "Reddit thread",
        desc="레딧 글",
        vec=v(0.99, 0.1, 0, 0),
        content='{"post_title": "t", "comments": [{"author": "a", "text": "재밌다"}]}',
    )
    s = make_settings(tmp_path)
    run_once(conn, s, write=False)
    sid = conn.execute("SELECT id FROM stories").fetchone()["id"]
    # 다른 스토리가 시드를 가져간 상태를 재현한다.
    conn.execute(
        "UPDATE story_sources SET role='community' WHERE story_id=? AND role='seed'", (sid,)
    )

    called = {"n": 0}

    def handler(request):
        called["n"] += 1
        return httpx.Response(500, json={})

    run_once(conn, s, chat=_chat(handler))
    row = conn.execute("SELECT status, skip_reason FROM stories WHERE id=?", (sid,)).fetchone()
    assert row["status"] == "skipped"
    assert row["skip_reason"] == "재료부족"
    assert called["n"] == 0


def test_write_story_translates_community_comments(conn, tmp_path, monkeypatch):
    s = make_settings(tmp_path, web_url="https://web.example", web_api_key="k")
    sid = _story_with_comments(conn, s, [
        {"author": "alice", "text": "Bill is a good pick"},
        {"author": "bob", "text": "wanted Pattinson"},
    ])
    calls = {"translate": 0, "writer": 0}

    def translate(n):
        ko = [
            {"author": "alice", "text": "빌이 좋은 선택이다"},
            {"author": "bob", "text": "솔직히 패틴슨을 원했다"},
        ]
        return json.dumps(ko, ensure_ascii=False)

    sent = _capture_payloads(monkeypatch)
    write_story(
        conn, s, _chat(_handler(calls, translate)), story_id=sid, run_id=None,
        prompts=load_prompts(PROMPTS), pver=prompt_version(PROMPTS),
    )

    assert calls == {"translate": 1, "writer": 1}
    comments = _community_comments(sent[0])
    assert [c["author"] for c in comments] == ["alice", "bob"]  # author 는 번역하지 않는다
    assert [c["text"] for c in comments] == ["빌이 좋은 선택이다", "솔직히 패틴슨을 원했다"]
    assert all(set(c) == {"author", "text"} for c in comments)  # 원문 필드는 넣지 않는다
    usage = list(conn.execute("SELECT role, story_id, model FROM llm_usage ORDER BY id"))
    assert [(r["role"], r["story_id"], r["model"]) for r in usage] == [
        ("translate", sid, "test/translate"),
        ("writer", sid, "test/writer"),
    ]


@pytest.mark.parametrize("bad", [
    "번역 결과가 아직 JSON 이 아니다",
    '[{"author": "alice", "text": "하나뿐"}]',
])
def test_write_story_keeps_original_comments_when_translation_fails(
    conn, tmp_path, monkeypatch, bad,
):
    original = [
        {"author": "alice", "text": "Bill is a good pick"},
        {"author": "bob", "text": "wanted Pattinson"},
    ]
    s = make_settings(tmp_path, web_url="https://web.example", web_api_key="k")
    sid = _story_with_comments(conn, s, original)
    calls = {"translate": 0, "writer": 0}
    sent = _capture_payloads(monkeypatch)

    write_story(
        conn, s, _chat(_handler(calls, lambda n: bad)), story_id=sid, run_id=None,
        prompts=load_prompts(PROMPTS), pver=prompt_version(PROMPTS),
    )

    assert calls["translate"] == 1
    assert _community_comments(sent[0]) == original  # 원문 유지
    st = conn.execute("SELECT status FROM stories WHERE id=?", (sid,)).fetchone()
    assert st["status"] == "published"  # 발행은 계속된다


def test_write_story_skips_translation_when_comments_are_korean(conn, tmp_path, monkeypatch):
    korean = [{"author": "alice", "text": "진짜 재밌다 ㅋㅋ"}]
    s = make_settings(tmp_path, web_url="https://web.example", web_api_key="k")
    sid = _story_with_comments(conn, s, korean)
    calls = {"translate": 0, "writer": 0}
    sent = _capture_payloads(monkeypatch)

    write_story(
        conn, s, _chat(_handler(calls, lambda n: "[]")), story_id=sid, run_id=None,
        prompts=load_prompts(PROMPTS), pver=prompt_version(PROMPTS),
    )

    assert calls == {"translate": 0, "writer": 1}  # 한국어뿐이면 번역 호출 없음
    assert _community_comments(sent[0]) == korean


def test_write_story_republish_translates_comments_again(conn, tmp_path, monkeypatch):
    s = make_settings(tmp_path, web_url="https://web.example", web_api_key="k")
    sid = _story_with_comments(conn, s, [{"author": "alice", "text": "Bill is a good pick"}])
    calls = {"translate": 0, "writer": 0}
    sent = _capture_payloads(monkeypatch)
    chat = _chat(_handler(
        calls,
        lambda n: json.dumps([{"author": "alice", "text": f"{n}번째 번역"}], ensure_ascii=False),
    ))
    prompts, pver = load_prompts(PROMPTS), prompt_version(PROMPTS)

    write_story(conn, s, chat, story_id=sid, run_id=None, prompts=prompts, pver=pver)
    write_story(conn, s, chat, story_id=sid, run_id=None, prompts=prompts, pver=pver)

    assert calls == {"translate": 2, "writer": 1}  # 재발행은 본문을 다시 쓰지 않는다
    assert [c["text"] for c in _community_comments(sent[0])] == ["1번째 번역"]
    assert [c["text"] for c in _community_comments(sent[1])] == ["2번째 번역"]
    assert sent[0]["body_html"] == sent[1]["body_html"]  # 본문은 재사용
    assert "본문이다" in sent[1]["body_html"]
    assert "tags" not in sent[1]
    n = conn.execute("SELECT COUNT(*) c FROM articles").fetchone()["c"]
    assert n == 1
