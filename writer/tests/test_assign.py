from __future__ import annotations

from writer.assign import apply_cap, prepare, should_write
from writer.cluster import cluster_articles, expand
from writer.db import iso_hours_ago, load_candidates, load_window
from writer.models import StoryRow

from conftest import MODEL, add_item, add_source, v


def _cluster(conn, threshold=0.72):
    cands = load_candidates(conn, MODEL, iso_hours_ago(36))
    window = load_window(conn, MODEL, iso_hours_ago(168))
    clusters = cluster_articles(cands, threshold)
    for c in clusters:
        expand(c, window, article_min=0.65, article_k=8, community_min=0.70, community_k=3)
    return clusters


def test_two_sources_always_write(conn):
    a = add_source(conn, "IGN", weight=1.0)
    b = add_source(conn, "Gematsu", weight=1.0)
    add_item(conn, a, "A", desc="short", vec=v(1, 0, 0, 0))
    add_item(conn, b, "B", desc="short", vec=v(0.98, 0.1, 0, 0))
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert ok and reason is None


def test_title_only_singleton_is_skipped(conn):
    a = add_source(conn, "4Gamer")
    add_item(conn, a, "Title only", desc="", vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert not ok and reason == "제목만"
    p = prepare(c, [], min_weight=1.0, min_desc=200, followup=0.80, related=0.70)
    assert p.decision == "skip"


def test_short_singleton_still_writes(conn):
    a = add_source(conn, "PC Gamer", weight=1.0)
    add_item(conn, a, "Thin", desc="short", vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    p = prepare(c, [], min_weight=1.0, min_desc=200, followup=0.80, related=0.70)
    assert p.decision == "write"


def test_long_official_singleton_writes(conn):
    a = add_source(conn, "PlayStation Blog", weight=1.5)
    add_item(conn, a, "Launch", desc="x" * 250, vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert ok and reason is None


def test_two_sources_score_higher_than_singleton(conn):
    a = add_source(conn, "IGN", weight=1.0)
    b = add_source(conn, "Gematsu", weight=1.0)
    add_item(conn, a, "A", desc="short", vec=v(1, 0, 0, 0))
    add_item(conn, b, "B", desc="short", vec=v(0.98, 0.1, 0, 0))
    two = _cluster(conn)[0]
    from writer.assign import importance
    from writer.models import Cluster, Item
    from writer.vec import normalize
    one = Cluster(
        seeds=[Item(1, 1, "IGN", "article", 1.0, "u", "t", "short", "", None, "n",
                    normalize([0, 1, 0, 0]))],
        centroid=normalize([0, 1, 0, 0]),
    )
    assert importance(two) > importance(one)


def test_high_similarity_is_merge(conn):
    a = add_source(conn, "IGN")
    add_item(conn, a, "Same event", desc="x" * 250, vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    existing = [StoryRow(id=9, slug="s9", status="published", skip_reason=None,
                         centroid=c.centroid[:], source_count=1, community_count=0)]
    p = prepare(c, existing, min_weight=1.0, min_desc=200, followup=0.80, related=0.70)
    assert p.decision == "merge"
    assert p.relation == "followup"
    assert p.existing and p.existing.id == 9


def test_mid_similarity_is_related_new_story(conn):
    a = add_source(conn, "IGN")
    add_item(conn, a, "Kinda", desc="x" * 250, vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    # ~0.75 vs [0.75, 0.66, 0, 0] normalized
    other = [0.75, 0.6614378, 0.0, 0.0]
    n = sum(x * x for x in other) ** 0.5
    other = [x / n for x in other]
    existing = [StoryRow(id=3, slug="s3", status="published", skip_reason=None,
                         centroid=other, source_count=2, community_count=0)]
    p = prepare(c, existing, min_weight=1.0, min_desc=200, followup=0.80, related=0.70)
    assert p.decision == "write"
    assert p.relation == "related"
    assert p.existing and p.existing.id == 3


def test_cap_defers_low_importance_writes(conn):
    a = add_source(conn, "PlayStation Blog", weight=1.5)
    b = add_source(conn, "Xbox Wire", weight=1.5)
    add_item(conn, a, "PS thing", desc="x" * 250, vec=v(1, 0, 0, 0))
    add_item(conn, b, "Xbox thing", desc="x" * 250, vec=v(0, 1, 0, 0))
    prepared = [prepare(c, [], min_weight=1.5, min_desc=200, followup=0.80, related=0.70)
                for c in _cluster(conn)]
    assert all(p.decision == "write" for p in prepared)
    capped = apply_cap(prepared, 1)
    writes = [p for p in capped if p.decision == "write"]
    deferred = [p for p in capped if (p.skip_reason or "").startswith("한도")]
    assert len(writes) == 1
    assert len(deferred) == 1
