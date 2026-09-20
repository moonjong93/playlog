"""모델 경합은 발행 테이블을 건드리지 않는다."""

from __future__ import annotations

import json

import httpx

from writer.bench import article_body, keep_terms, parse_models, pick_translate_items, run_bench, show_run
from writer.llm import OpenRouterChat

from conftest import add_item, add_source, make_settings


def _chat(handler) -> OpenRouterChat:
    c = OpenRouterChat("https://or/api/v1", "secret", min_interval=0.0)
    c._client = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer secret"},
    )
    return c


def test_article_body_prefers_longer_non_json_content():
    assert article_body({"description": "short", "content": "much longer article text"}) == "much longer article text"
    assert article_body({"description": "rss teaser", "content": '{"comments":[]}'}) == "rss teaser"


def test_keep_terms_locks_original_title():
    blob = keep_terms("My Nintendo Fire Emblem: Fortune's Weave Heroic Sweepstakes")
    assert "Fire Emblem: Fortune's Weave" in blob
    assert blob.splitlines()[0].startswith("- My Nintendo")


def test_keep_terms_does_not_lock_japanese_sentence():
    blob = keep_terms(
        "チェーンソー持ちのチアリーダーと。「LOLLIPOP CHAINSAW 2 Back2Back」を世界初体験"
    )
    assert "チアリーダー" not in blob
    assert "LOLLIPOP CHAINSAW 2 Back2Back" in blob


def test_missing_terms_flags_invented_translation_without_rewriting():
    from writer.bench import missing_terms
    orig = "My Nintendo Fire Emblem: Fortune's Weave Heroic Sweepstakes Announced"
    assert "Fire Emblem: Fortune's Weave" in missing_terms("불의 운명 추첨전 발표", orig)
    assert missing_terms("Fire Emblem: Fortune's Weave 추첨전 발표", orig) == []


def test_missing_terms_ignores_japanese_source_text():
    from writer.bench import missing_terms
    orig = "チアリーダーが帰ってきた。「LOLLIPOP CHAINSAW 2 Back2Back」世界初体験"
    miss = missing_terms("치어리더가 돌아왔다", orig)
    assert "チアリーダー" not in " ".join(miss)
    assert "LOLLIPOP CHAINSAW 2 Back2Back" in miss


def test_find_cjk_leaks_excludes_hangul():
    from writer.bench import find_cjk_leaks
    assert find_cjk_leaks("메가포트新作 로그라이트") == ["新作"]
    assert find_cjk_leaks("부채利率 상승") == ["利率"]
    assert find_cjk_leaks("순수 한국어 문장입니다") == []


def test_parse_models_dedupes():
    assert parse_models("a, b, a") == ["a", "b"]
    assert parse_models("")[0] == "inclusionai/ling-3.0-flash"


def test_default_models_include_gemma_and_luna():
    names = parse_models("")
    assert "google/gemma-4-26b-a4b-it" in names
    assert "openai/gpt-5.6-luna" in names


def test_pick_spreads_sources(conn):
    ign = add_source(conn, "IGN")
    gem = add_source(conn, "Gematsu")
    add_item(conn, ign, "IGN one", desc="d" * 90)
    add_item(conn, ign, "IGN two", desc="d" * 90)
    add_item(conn, gem, "Gematsu one", desc="d" * 90)
    picked = pick_translate_items(conn, hours=48, limit=2)
    names = {p["source_name"] for p in picked}
    assert names == {"IGN", "Gematsu"}


def test_translate_bench_does_not_touch_articles(conn, tmp_path):
    src = add_source(conn, "IGN")
    add_item(conn, src, "Resident Evil Requiem dated", desc="Capcom announced the date. " * 8)

    seen_models = []

    def handler(request):
        body = json.loads(request.content)
        seen_models.append(body["model"])
        payload = {"title_ko": f"제목-{body['model']}", "body_md": f"본문-{body['model']}"}
        return httpx.Response(200, json={
            "id": "gen-1",
            "model": body["model"],
            "choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 8, "cost": 0.0},
        })

    settings = make_settings(tmp_path)
    stats = run_bench(
        conn, settings, _chat(handler),
        task="translate", models=["qwen/qwen3.7-flash", "mistralai/mistral-nemo"],
        limit=1, hours=48,
    )
    assert stats["cases"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM articles").fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM stories").fetchone()["c"] == 0
    outs = conn.execute("SELECT model, title_ko FROM bench_outputs ORDER BY model").fetchall()
    # 모델 한국어 제목을 그대로 둔다(가드가 원문으로 덮어쓰지 않는다)
    assert {r["title_ko"] for r in outs} == {
        "제목-qwen/qwen3.7-flash", "제목-mistralai/mistral-nemo",
    }
    report = show_run(conn, stats["run_id"])
    assert "Resident Evil" in report
    latest = tmp_path / "out" / "bench" / "latest.md"
    index = tmp_path / "out" / "bench" / "index.md"
    assert latest.is_file() and "Resident Evil" in latest.read_text(encoding="utf-8")
    assert index.is_file() and "latest.md" in index.read_text(encoding="utf-8")


def test_keeps_raw_text_when_json_missing(conn, tmp_path):
    src = add_source(conn, "PC Gamer")
    add_item(conn, src, "Some game ships", desc="It ships tomorrow on Steam. " * 6)

    def handler(request):
        return httpx.Response(200, json={
            "id": "gen-2",
            "model": "m",
            "choices": [{"message": {"content": "그냥 문장이지 JSON 이 아니다"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 4},
        })

    stats = run_bench(
        conn, make_settings(tmp_path), _chat(handler),
        task="translate", models=["m"], limit=1, hours=48,
    )
    row = conn.execute("SELECT error, raw_text FROM bench_outputs WHERE run_id=?",
                       (stats["run_id"],)).fetchone()
    assert row["error"]
    assert "JSON" in row["error"]
    assert "그냥 문장" in row["raw_text"]
