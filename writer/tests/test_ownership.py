from __future__ import annotations

import pytest

from writer.pipeline import run_once

from conftest import add_item, add_source, make_settings, v


def test_update_raw_items_is_rejected(conn):
    with pytest.raises(RuntimeError, match="collector"):
        conn.execute("UPDATE raw_items SET status='x' WHERE id=1")


def test_delete_sources_is_rejected(conn):
    with pytest.raises(RuntimeError, match="collector"):
        conn.execute("DELETE FROM sources")


def test_insert_item_embeddings_is_rejected(conn):
    with pytest.raises(RuntimeError, match="collector"):
        conn.execute(
            "INSERT INTO item_embeddings (raw_item_id, model, dim, vec, text_hash, created_at) "
            "VALUES (1, 'x', 1, X'00', 'h', 'now')"
        )


def test_select_raw_items_is_allowed(conn):
    add_source(conn, "IGN")
    rows = conn.execute("SELECT COUNT(*) c FROM raw_items").fetchone()
    assert rows["c"] == 0


def test_persist_does_not_mutate_collector_rows(conn, tmp_path):
    ign = add_source(conn, "IGN")
    gem = add_source(conn, "Gematsu")
    add_item(conn, ign, "P4 trailer", desc="x" * 250, vec=v(1, 0, 0, 0))
    add_item(conn, gem, "P4 Naoto", desc="x" * 250, vec=v(0.98, 0.1, 0, 0))
    before = [
        tuple(r) for r in conn.raw.execute(
            "SELECT id, status, title, url, description FROM raw_items ORDER BY id"
        )
    ]
    before_e = [
        tuple(r) for r in conn.raw.execute(
            "SELECT raw_item_id, model, dim FROM item_embeddings ORDER BY raw_item_id"
        )
    ]
    s = make_settings(tmp_path)
    stats = run_once(conn, s, dry_run=False, write=False, chat=None)
    assert stats["stories_new"] >= 1
    after = [
        tuple(r) for r in conn.raw.execute(
            "SELECT id, status, title, url, description FROM raw_items ORDER BY id"
        )
    ]
    after_e = [
        tuple(r) for r in conn.raw.execute(
            "SELECT raw_item_id, model, dim FROM item_embeddings ORDER BY raw_item_id"
        )
    ]
    assert after == before
    assert after_e == before_e
