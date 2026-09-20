from __future__ import annotations

from writer.cluster import claimed_hits, cluster_articles, expand
from writer.db import iso_hours_ago, load_candidates, load_window
from writer.models import Item
from writer.vec import dot, normalize

from conftest import MODEL, add_item, add_source, v


def _items(conn):
    return load_candidates(conn, MODEL, iso_hours_ago(36))


def test_cross_source_similar_items_cluster(conn):
    ign = add_source(conn, "IGN")
    gem = add_source(conn, "Gematsu")
    add_item(conn, ign, "Persona 4 Revival trailer", vec=v(1, 0, 0, 0))
    add_item(conn, gem, "Persona 4 Revival Naoto", vec=v(0.98, 0.1, 0, 0))
    clusters = cluster_articles(_items(conn), 0.72)
    assert len(clusters) == 1
    assert len(clusters[0].seeds) == 2


def test_same_source_does_not_cluster(conn):
    ign = add_source(conn, "IGN")
    add_item(conn, ign, "A", vec=v(1, 0, 0, 0))
    add_item(conn, ign, "B", vec=v(0.98, 0.1, 0, 0))
    clusters = cluster_articles(_items(conn), 0.72)
    assert len(clusters) == 2
    assert all(len(c.seeds) == 1 for c in clusters)


def test_orthogonal_items_are_separate(conn):
    a = add_source(conn, "IGN")
    b = add_source(conn, "Gematsu")
    add_item(conn, a, "A", vec=v(1, 0, 0, 0))
    add_item(conn, b, "B", vec=v(0, 1, 0, 0))
    clusters = cluster_articles(_items(conn), 0.72)
    assert len(clusters) == 2


def test_community_is_not_a_seed(conn):
    a = add_source(conn, "IGN")
    r = add_source(conn, "Reddit", kind="community", weight=0.8)
    add_item(conn, a, "Article", vec=v(1, 0, 0, 0))
    add_item(conn, r, "Reddit post", vec=v(1, 0, 0, 0))
    clusters = cluster_articles(_items(conn), 0.72)
    assert len(clusters) == 1
    assert clusters[0].seeds[0].source_kind == "article"


def test_expand_attaches_retrieved_and_community(conn):
    ign = add_source(conn, "IGN")
    poly = add_source(conn, "Polygon")
    reddit = add_source(conn, "Reddit", kind="community", weight=0.8)
    add_item(conn, ign, "Seed2", vec=v(1, 0, 0, 0))
    add_item(conn, poly, "Related2", vec=v(0.7, 0.7, 0.14, 0))  # ~0.70
    add_item(conn, reddit, "Thread2", vec=v(0.95, 0.1, 0, 0))
    cands = load_candidates(conn, MODEL, iso_hours_ago(36))
    window = load_window(conn, MODEL, iso_hours_ago(168))
    clusters = cluster_articles(cands, 0.72)
    seed = next(c for c in clusters if any(s.title == "Seed2" for s in c.seeds))
    expand(seed, window, article_min=0.65, article_k=8, community_min=0.70, community_k=3)
    assert any(h.item.title == "Related2" for h in seed.retrieved)
    assert any(h.item.title == "Thread2" for h in seed.community)
    hits = claimed_hits(seed)
    # retrieved ~0.70 < 0.72 → 팩에는 있으나 claim 은 안 함
    assert all(h.item.title != "Related2" for h in hits)
    assert any(h.item.title == "Thread2" for h in hits)


def test_claim_threshold_follows_setting(conn):
    ign = add_source(conn, "IGN")
    reddit = add_source(conn, "Reddit", kind="community", weight=0.8)
    add_item(conn, ign, "Seed3", vec=v(1, 0, 0, 0))
    add_item(conn, reddit, "Thread3", vec=v(0.52, 0.854, 0, 0))  # ~0.52
    cands = load_candidates(conn, MODEL, iso_hours_ago(36))
    window = load_window(conn, MODEL, iso_hours_ago(168))
    seed = next(c for c in cluster_articles(cands, 0.72) if c.seeds[0].title == "Seed3")
    expand(seed, window, article_min=0.65, article_k=8, community_min=0.50, community_k=3)
    assert any(h.item.title == "Thread3" for h in seed.community)
    # 기본 상수(0.58)로는 claim 되지 않는다.
    assert all(h.item.title != "Thread3" for h in claimed_hits(seed))
    # 설정값을 넘기면 claim 된다.
    assert any(
        h.item.title == "Thread3"
        for h in claimed_hits(seed, community_min=0.50)
    )


def test_expand_prefers_community_with_comments(conn):
    ign = add_source(conn, "IGN")
    reddit = add_source(conn, "Reddit", kind="community", weight=0.8)
    add_item(conn, ign, "Seed4", vec=v(1, 0, 0, 0))
    add_item(conn, reddit, "NoComments", vec=v(0.99, 0.14, 0, 0))
    add_item(
        conn, reddit, "WithComments",
        desc="레딧 글",
        vec=v(0.95, 0.31, 0, 0),
        content='{"post_title": "t", "comments": [{"author": "a", "text": "재밌다"}]}',
    )
    cands = load_candidates(conn, MODEL, iso_hours_ago(36))
    window = load_window(conn, MODEL, iso_hours_ago(168))
    seed = next(c for c in cluster_articles(cands, 0.72) if c.seeds[0].title == "Seed4")
    expand(seed, window, article_min=0.65, article_k=8, community_min=0.50, community_k=1)
    # 유사도는 NoComments 가 높지만, 반응(댓글)이 있는 쪽을 쓴다.
    assert [h.item.title for h in seed.community] == ["WithComments"]


def test_seed_is_not_stolen_by_other_cluster_retrieved(conn):
    """같은 매체 기사는 클러스터가 갈리지만 retrieved 로는 붙는다. 그때 남의 시드를 훔치면 안 된다."""
    pcg = add_source(conn, "PC Gamer")
    add_item(conn, pcg, "Cluster A seed", desc="x" * 250, vec=v(1, 0, 0, 0))
    add_item(conn, pcg, "CD Projekt article", desc="y" * 250, vec=v(0.99, 0.1, 0, 0))
    cands = load_candidates(conn, MODEL, iso_hours_ago(36))
    window = load_window(conn, MODEL, iso_hours_ago(168))
    # 같은 매체라 임계값과 무관하게 두 클러스터로 갈린다.
    clusters = cluster_articles(cands, 0.72)
    assert len(clusters) == 2
    other = next(c for c in clusters if c.seeds[0].title == "Cluster A seed")
    cd = next(c for c in clusters if c.seeds[0].title == "CD Projekt article")
    expand(other, window, article_min=0.65, article_k=8, community_min=0.50, community_k=3)
    assert any(h.item.title == "CD Projekt article" for h in other.retrieved)
    reserved = {s.id for c in clusters for s in c.seeds}

    # 예약이 없으면 retrieved 가 남의 시드를 가져간다(예전 버그).
    stolen = claimed_hits(other, reserved=set())
    assert any(h.item.title == "CD Projekt article" for h in stolen)
    # 예약이 있으면 시드는 자기 스토리에 남는다.
    kept = claimed_hits(other, reserved=reserved)
    assert all(h.item.title != "CD Projekt article" for h in kept)
    assert any(h.item.title == "CD Projekt article" for h in claimed_hits(cd))


def test_centroid_is_normalized():
    a = Item(1, 1, "A", "article", 1.0, "u", "t", "d", "", None, "now", normalize([1.0, 0, 0, 0]))
    b = Item(2, 2, "B", "article", 1.0, "u", "t", "d", "", None, "now", normalize([0.8, 0.6, 0, 0]))
    clusters = cluster_articles([a, b], 0.72)
    assert len(clusters) == 1
    c = clusters[0].centroid
    assert abs(dot(c, c) - 1.0) < 1e-5
