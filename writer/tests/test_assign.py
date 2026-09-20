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


def test_two_sources_with_material_write(conn):
    a = add_source(conn, "IGN", weight=1.0)
    b = add_source(conn, "Gematsu", weight=1.0)
    add_item(conn, a, "Persona 4 Revival trailer",
             desc="Persona 4 Revival trailer is out now. " + "x" * 250, vec=v(1, 0, 0, 0))
    add_item(conn, b, "Persona 4 Revival remake",
             desc="Persona 4 Revival remake plans confirmed. " + "y" * 250, vec=v(0.98, 0.1, 0, 0))
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert ok and reason is None


def test_title_only_singleton_is_skipped(conn):
    a = add_source(conn, "4Gamer")
    add_item(conn, a, "Title only", desc="", vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert not ok and reason == "재료부족"
    p = prepare(c, [], min_weight=1.0, min_desc=200, followup=0.80, related=0.70)
    assert p.decision == "skip"


def test_short_singleton_is_skipped(conn):
    """PC Gamer 처럼 30자 발췌만 주는 소스는 재료로 보지 않는다."""
    a = add_source(conn, "PC Gamer", weight=1.0)
    add_item(conn, a, "Thin", desc="short", vec=v(1, 0, 0, 0))
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert not ok and reason == "재료부족"
    p = prepare(c, [], min_weight=1.0, min_desc=200, followup=0.80, related=0.70)
    assert p.decision == "skip"


def test_long_official_singleton_writes(conn):
    a = add_source(conn, "PlayStation Blog", weight=1.5)
    add_item(conn, a, "Monster Hunter Wilds launch",
             desc="Monster Hunter Wilds launch is today. " + "x" * 250, vec=v(1, 0, 0, 0))
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
    add_item(conn, a, "Kinda important update",
             desc="Kinda important update summary. " + "x" * 250, vec=v(1, 0, 0, 0))
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
    add_item(conn, a, "PS5 exclusive launch",
             desc="PS5 exclusive launch summary. " + "x" * 250, vec=v(1, 0, 0, 0))
    add_item(conn, b, "Xbox exclusive launch",
             desc="Xbox exclusive launch summary. " + "x" * 250, vec=v(0, 1, 0, 0))
    prepared = [prepare(c, [], min_weight=1.5, min_desc=200, followup=0.80, related=0.70)
                for c in _cluster(conn)]
    assert all(p.decision == "write" for p in prepared)
    capped = apply_cap(prepared, 1)
    writes = [p for p in capped if p.decision == "write"]
    deferred = [p for p in capped if (p.skip_reason or "").startswith("한도")]
    assert len(writes) == 1
    assert len(deferred) == 1


def test_pcgamer_style_bio_is_not_material(conn):
    """PC Gamer 처럼 summary 자리에 기자 소개문이 오면 재료로 보지 않는다."""
    pcg = add_source(conn, "PC Gamer")
    add_item(
        conn, pcg,
        "I played the adventure game so scandalous that it was physically destroyed by UK customs",
        desc="Rick has been fascinated by PC gaming since he was seven years old. "
             "He grew up on a diet of similarly unsuitable games. " * 8,
        vec=v(1, 0, 0, 0),
    )
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert not ok and reason == "재료부족"


def test_cjk_short_summary_is_material(conn):
    """일본어 요약은 100자 남짓이어도 재료로 본다(CJK 는 글자당 정보량이 크다)."""
    g4 = add_source(conn, "4Gamer")
    add_item(
        conn, g4,
        "ソウル・トリアージADV「UN:Me」，2027年に発売延期。主人公役は花守ゆみりさんに決定",
        desc="集英社ゲームズは本日（2026年9月17日），ソウル・トリアージアドベンチャー「UN:Me」の"
             "発売時期を2027年に延期すると発表した。あわせて，主人公役を花守ゆみりさんが担当する"
             "ことを発表し，少女に宿る4つの魂のうち，魂IIと魂IVの詳細を公開した。",
        vec=v(1, 0, 0, 0),
    )
    c = _cluster(conn)[0]
    ok, reason = should_write(c, min_weight=1.0, min_desc=200)
    assert ok and reason is None
