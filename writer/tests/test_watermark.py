"""섭취 커서는 시각이 아니라 raw_items.id 워터마크."""

from __future__ import annotations

from writer.pipeline import run_once
from writer.store import get_intake_after_id

from conftest import add_item, add_source, make_settings, v


def test_first_run_takes_newest_limit_and_advances(conn, tmp_path):
    src = add_source(conn, "IGN", weight=1.5)
    ids = []
    for i in range(5):
        ids.append(add_item(conn, src, f"Item {i}", desc="x" * 250, vec=v(1, 0, 0, i * 0.01)))
    s = make_settings(tmp_path, batch_limit=3)
    stats = run_once(conn, s, write=False)
    assert stats["items_seen"] == 3
    mark = get_intake_after_id(conn)
    assert mark == max(ids)          # 최신 3건의 max id = 전체 max
    # 더 새 항목이 없으면 다음 배치는 비다
    stats2 = run_once(conn, s, write=False)
    assert stats2["items_seen"] == 0


def test_overflow_is_not_dropped_when_watermark_is_below_max(conn, tmp_path):
    """FIFO 경로: 워터마크를 낮게 두면 잘린 건이 다음 배치로 온다."""
    src = add_source(conn, "IGN", weight=1.5)
    ids = [add_item(conn, src, f"N {i}", desc="x" * 250, vec=v(1, 0, 0, 0)) for i in range(5)]
    s = make_settings(tmp_path, batch_limit=2)
    from writer.store import set_intake_after_id
    set_intake_after_id(conn, ids[0])          # id[0] 다음부터 FIFO
    stats = run_once(conn, s, write=False)
    assert stats["items_seen"] == 2
    assert get_intake_after_id(conn) == ids[2]
    stats2 = run_once(conn, s, write=False)
    assert stats2["items_seen"] == 2
    assert get_intake_after_id(conn) == ids[4]


def test_new_items_after_watermark_are_picked_up(conn, tmp_path):
    src = add_source(conn, "PlayStation Blog", weight=1.5)
    add_item(conn, src, "Old", desc="x" * 250, vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path, batch_limit=100)
    run_once(conn, s, write=False)
    mark = get_intake_after_id(conn)
    nid = add_item(conn, src, "New", desc="x" * 250, vec=v(0, 1, 0, 0))
    assert nid > mark
    stats = run_once(conn, s, write=False)
    assert stats["items_seen"] == 1
    assert get_intake_after_id(conn) == nid


def test_dry_run_does_not_advance_watermark(conn, tmp_path):
    src = add_source(conn, "IGN", weight=1.5)
    add_item(conn, src, "A", desc="x" * 250, vec=v(1, 0, 0, 0))
    s = make_settings(tmp_path)
    run_once(conn, s, write=False, dry_run=True)
    assert get_intake_after_id(conn) is None
