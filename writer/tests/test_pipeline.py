from __future__ import annotations

import json

import httpx

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


def test_short_singleton_is_written_not_skipped(conn, tmp_path):
    a = add_source(conn, "PC Gamer")
    add_item(conn, a, "Tiny blurb", desc="60 chars", vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path)
    stats = run_once(conn, s, write=False)
    row = conn.execute("SELECT status, skip_reason FROM stories").fetchone()
    assert row["status"] == "clustered"
    assert not row["skip_reason"]
    assert conn.execute("SELECT COUNT(*) c FROM writing_items").fetchone()["c"] == 1
    assert stats["stories_new"] == 1


def test_merge_attaches_to_existing_story(conn, tmp_path):
    ign = add_source(conn, "IGN")
    gem = add_source(conn, "Gematsu")
    add_item(conn, ign, "First", desc="short", vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path)
    run_once(conn, s, write=False)
    sid = conn.execute("SELECT id FROM stories").fetchone()["id"]
    assert conn.execute("SELECT status FROM stories").fetchone()["status"] == "clustered"
    add_item(conn, gem, "Follow-up", desc="short", vec=v(0.99, 0.05, 0, 0))
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
