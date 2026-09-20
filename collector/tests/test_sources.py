"""sources.yaml → sources 테이블 동기화. enabled 를 yaml 기준으로 반영하는지 검증."""

from __future__ import annotations

from pathlib import Path

import pytest

from collector.db import connect, init_db
from collector.sources import sync_sources

SCHEMA = Path(__file__).resolve().parents[1] / "db" / "schema.sql"

TWO = """
sources:
  - name: A
    feed_url: https://a/feed
    lang: en
  - name: B
    feed_url: https://b/feed
    lang: en
    enabled: false
"""

ONE = """
sources:
  - name: A
    feed_url: https://a/feed
    lang: en
"""


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    init_db(c, SCHEMA)
    yield c
    c.close()


def _yaml(tmp_path, text: str) -> Path:
    p = tmp_path / "sources.yaml"
    p.write_text(text, encoding="utf-8")
    return p


def _enabled(conn) -> dict[str, int]:
    return {r["name"]: r["enabled"] for r in conn.execute("SELECT name, enabled FROM sources")}


def test_sync_creates(conn, tmp_path):
    sync_sources(conn, _yaml(tmp_path, TWO))
    assert _enabled(conn) == {"A": 1, "B": 0}   # yaml 의 enabled: false 반영


def test_sync_reenables(conn, tmp_path):
    sync_sources(conn, _yaml(tmp_path, TWO))
    sync_sources(conn, _yaml(tmp_path, TWO.replace("enabled: false", "enabled: true")))
    assert _enabled(conn)["B"] == 1


def test_sync_disables_removed_feed(conn, tmp_path):
    sync_sources(conn, _yaml(tmp_path, TWO.replace("enabled: false", "enabled: true")))
    stats = sync_sources(conn, _yaml(tmp_path, ONE))
    assert stats["disabled"] == 1
    assert _enabled(conn)["B"] == 0
