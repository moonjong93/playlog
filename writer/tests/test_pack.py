from __future__ import annotations

from writer.models import Cluster, Hit, Item
from writer.pack import build_pack
from writer.vec import normalize


def _item(**kw):
    base = dict(
        id=1, source_id=1, source_name="IGN", source_kind="article",
        source_weight=1.0, url="https://ign.example/a", title="Hello",
        description="summary here", content="", published_at="2026-09-18T00:00:00Z",
        fetched_at="2026-09-18T00:00:00Z", vec=normalize([1, 0, 0, 0]),
    )
    base.update(kw)
    return Item(**base)


def test_pack_includes_title_url_summary():
    c = Cluster(seeds=[_item()], centroid=normalize([1, 0, 0, 0]))
    text = build_pack(c)
    assert "IGN" in text
    assert "Hello" in text
    assert "https://ign.example/a" in text
    assert "summary here" in text
    assert "seed" in text


def test_pack_formats_reddit_json_comments():
    payload = (
        '{"post_title": "PHYSINT", "comments": ['
        '{"author": "alice", "text": "Bill is a good pick"},'
        '{"author": "bob", "text": "wanted Pattinson"}'
        "]}"
    )
    comm = _item(
        id=2, source_id=9, source_name="Reddit r/Games", source_kind="community",
        title="PHYSINT thread", content=payload,
    )
    c = Cluster(seeds=[_item()], centroid=normalize([1, 0, 0, 0]),
                community=[Hit(comm, 0.81, "community")])
    text = build_pack(c)
    assert '{"post_title"' not in text
    assert "u/alice: Bill is a good pick" in text
    assert "u/bob: wanted Pattinson" in text


def test_pack_clips_long_summary_and_marks_community():
    long = "가" * 2000
    seed = _item(description=long)
    comm = _item(id=2, source_id=9, source_name="Reddit r/Games", source_kind="community",
                 title="fans react", description="lol", content="comment " * 400)
    c = Cluster(seeds=[seed], centroid=normalize([1, 0, 0, 0]),
                community=[Hit(comm, 0.81, "community")])
    text = build_pack(c)
    assert "…" in text
    assert "community" in text
    assert "fans react" in text
    assert len(text) < 5000
