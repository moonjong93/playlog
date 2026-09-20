"""선별 휴리스틱 + 기존 스토리 병합 판단. LLM 없음."""

from __future__ import annotations

import math

from .cluster import CLAIM_RETRIEVED
from .models import Cluster, Prepared, StoryRow
from .vec import dot


def article_source_ids(cluster: Cluster) -> set[int]:
    ids = {s.source_id for s in cluster.seeds}
    for h in cluster.retrieved:
        if h.similarity >= CLAIM_RETRIEVED:
            ids.add(h.item.source_id)
    return ids


def has_body_material(cluster: Cluster) -> bool:
    """제목 말고 쓸 재료(요약·본문)가 하나라도 있는가. 제목만 있는 소스는 쓰지 않는다."""
    items = list(cluster.seeds) + [h.item for h in cluster.retrieved]
    return any((it.description or "").strip() or (it.content or "").strip() for it in items)


def should_write(cluster: Cluster, *, min_weight: float, min_desc: int) -> tuple[bool, str | None]:
    """발매 게이트가 아니다. 다만 제목만 있는 소스는 쓰지 않는다. 매체 수·weight는 importance 점수다."""
    _ = (min_weight, min_desc)
    if not has_body_material(cluster):
        return False, "제목만"
    return True, None


def importance(cluster: Cluster) -> float:
    nsrc = len(article_source_ids(cluster))
    w = max((s.source_weight for s in cluster.seeds), default=0.0)
    d = max((s.desc_len for s in cluster.seeds), default=0)
    return nsrc * 2 + w + math.log1p(d) + len(cluster.community) * 0.5


def best_match(centroid: list[float], stories: list[StoryRow], *,
               followup: float, related: float) -> tuple[StoryRow | None, float, str | None]:
    best: StoryRow | None = None
    best_sim = -1.0
    for st in stories:
        if not st.centroid:
            continue
        sim = dot(centroid, st.centroid)
        if sim > best_sim:
            best, best_sim = st, sim
    if best is None:
        return None, 0.0, None
    if best_sim >= followup:
        return best, best_sim, "followup"
    if best_sim >= related:
        return best, best_sim, "related"
    return None, best_sim, None


def apply_cap(prepared: list[Prepared], max_per_run: int) -> list[Prepared]:
    """write 상한. 넘는 것은 소비하지 않고 다음 주기로 넘긴다."""
    if max_per_run <= 0:
        return prepared
    ranked = sorted(
        (p for p in prepared if p.decision == "write"),
        key=lambda p: -p.importance,
    )
    keep = {id(p) for p in ranked[:max_per_run]}
    out: list[Prepared] = []
    for p in prepared:
        if p.decision == "write" and id(p) not in keep:
            out.append(Prepared(
                cluster=p.cluster, decision="skip", skip_reason=f"한도{max_per_run}",
                existing=p.existing, relation=p.relation,
                relation_score=p.relation_score, importance=p.importance,
            ))
        else:
            out.append(p)
    return out


def prepare(cluster: Cluster, existing: list[StoryRow], *,
            min_weight: float, min_desc: int,
            followup: float, related: float) -> Prepared:
    write, reason = should_write(cluster, min_weight=min_weight, min_desc=min_desc)
    target, score, rel = best_match(
        cluster.centroid, existing, followup=followup, related=related,
    )
    imp = importance(cluster)
    if rel == "followup" and target is not None:
        return Prepared(
            cluster=cluster, decision="merge", skip_reason=None,
            existing=target, relation="followup", relation_score=score, importance=imp,
        )
    if not write:
        return Prepared(
            cluster=cluster, decision="skip", skip_reason=reason,
            existing=target if rel == "related" else None,
            relation=rel if rel == "related" else None,
            relation_score=score if rel == "related" else 0.0,
            importance=imp,
        )
    return Prepared(
        cluster=cluster, decision="write", skip_reason=None,
        existing=target if rel == "related" else None,
        relation=rel if rel == "related" else None,
        relation_score=score if rel == "related" else 0.0,
        importance=imp,
    )
