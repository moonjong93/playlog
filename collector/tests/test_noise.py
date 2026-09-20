"""노이즈 규칙 필터 — 삭제하지 않고 표시만 하는지 검증."""

from __future__ import annotations

from pathlib import Path

import pytest

from collector.db import connect, init_db
from collector.noise import NoiseRules, apply_rules

SCHEMA = Path(__file__).resolve().parents[1] / "db" / "schema.sql"
RULES = Path(__file__).resolve().parents[1] / "config" / "noise_rules.yaml"


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    init_db(c, SCHEMA)
    c.execute("INSERT INTO sources (name, feed_url, kind, enabled, weight, lang, created_at) "
              "VALUES ('Polygon', 'https://p/feed', 'article', 1, 1.0, 'en', '2026-01-01T00:00:00Z')")
    c.execute("INSERT INTO sources (name, feed_url, kind, enabled, weight, lang, created_at) "
              "VALUES ('PlayStation Blog', 'https://ps/feed', 'article', 1, 1.5, 'en', '2026-01-01T00:00:00Z')")
    yield c
    c.close()


def _add(conn, source_id: int, title: str, desc: str = "") -> int:
    cur = conn.execute(
        "INSERT INTO raw_items (source_id, url, canonical_url, url_hash, title, description, "
        "published_at, fetched_at, status) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'new')",
        (source_id, f"https://e.com/{abs(hash(title))}", f"https://e.com/{abs(hash(title))}",
         str(abs(hash(title))), title, desc),
    )
    return int(cur.lastrowid)


def test_rules_load():
    r = NoiseRules.load(RULES)
    assert "PlayStation Blog" in r.allow_sources
    assert r.title_deny and r.title_allow


def test_filters_coupon_and_movie(conn):
    rules = NoiseRules.load(RULES)
    coupon = _add(conn, 1, "Free codes for Clover Legends (September 2026)")
    movie = _add(conn, 1, "Justice League MOVIE: What Can We Expect?")
    game = _add(conn, 1, "Silent Hill: Townfall creators break down PS5 features")

    apply_rules(conn, rules)
    status = {r["id"]: r["status"] for r in conn.execute("SELECT id, status FROM raw_items")}
    assert status[coupon] == "filtered"
    assert status[movie] == "filtered"
    assert status[game] == "new"          # 게임 기사는 보존


def test_official_source_is_never_filtered(conn):
    rules = NoiseRules.load(RULES)
    # 공식 채널은 allow_sources 라 deny 패턴이 있어도 보존
    rid = _add(conn, 2, "PlayStation Plus free codes giveaway")
    apply_rules(conn, rules)
    row = conn.execute("SELECT status, noise_reason FROM raw_items WHERE id = ?", (rid,)).fetchone()
    assert row["status"] == "new"
    assert row["noise_reason"] is None


def test_filter_keeps_row_and_reason(conn):
    rules = NoiseRules.load(RULES)
    rid = _add(conn, 1, "Best game deals this week: 50% off")
    stats = apply_rules(conn, rules)
    row = conn.execute("SELECT * FROM raw_items WHERE id = ?", (rid,)).fetchone()
    assert row is not None                 # 삭제하지 않는다
    assert row["status"] == "filtered"
    assert row["noise_reason"]             # 사유 기록
    assert stats["filtered"] == 1


def test_game_keyword_alone_does_not_protect(conn):
    """'game' 이 allow 에 있으면 'game deals' 가 통과해 버린다 — 구체적 신호만 허용."""
    rules = NoiseRules.load(RULES)
    rid = _add(conn, 1, "Game discounts roundup")
    apply_rules(conn, rules)
    assert conn.execute("SELECT status FROM raw_items WHERE id = ?", (rid,)).fetchone()["status"] == "filtered"


def test_code_list_title_is_filtered(conn):
    """코드 목록 글은 요약이 아니라 제목으로 걸러야 한다(deny 제목-only 보강)."""
    rules = NoiseRules.load(RULES)
    rid = _add(conn, 1, "Genshin Impact codes (September 2026)",
               "Here are redeem codes for free primogems.")
    apply_rules(conn, rules)
    assert conn.execute("SELECT status FROM raw_items WHERE id = ?", (rid,)).fetchone()["status"] == "filtered"


def test_deny_ignores_description(conn):
    """deny 는 제목만 본다 — 요약에 'movie' 가 있어도 게임 기사는 보존된다(실측 오탐)."""
    rules = NoiseRules.load(RULES)
    rid = _add(conn, 1, "Marvel's Wolverine makes me ask a serious question.",
               "The movie comparisons are unavoidable, but the game is its own thing.")
    apply_rules(conn, rules)
    assert conn.execute("SELECT status FROM raw_items WHERE id = ?", (rid,)).fetchone()["status"] == "new"
