"""유사도 클러스터 + 센트로이드 RAG 확장. LLM 없음."""

from __future__ import annotations

from .models import Cluster, Hit, Item
from .vec import centroid, dot

# 클러스터에 넣은 뒤 소비(claim)할 하한. RAG 팩에는 더 낮은 것도 넣는다.
CLAIM_RETRIEVED = 0.72
CLAIM_COMMUNITY = 0.58


def cluster_articles(items: list[Item], threshold: float) -> list[Cluster]:
    """교차 매체 유사도 >= threshold 로 union-find. 같은 매체 쌍은 엣지가 아니다."""
    articles = [it for it in items if it.source_kind == "article"]
    n = len(articles)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        vi = articles[i].vec
        si = articles[i].source_id
        for j in range(i + 1, n):
            if si == articles[j].source_id:
                continue
            if dot(vi, articles[j].vec) >= threshold:
                union(i, j)

    groups: dict[int, list[Item]] = {}
    for i, it in enumerate(articles):
        groups.setdefault(find(i), []).append(it)

    clusters: list[Cluster] = []
    for members in groups.values():
        cvec = centroid([m.vec for m in members])
        clusters.append(Cluster(seeds=members, centroid=cvec))
    clusters.sort(key=lambda c: (-len(c.seeds), -max(s.source_weight for s in c.seeds)))
    return clusters


def expand(cluster: Cluster, pool: list[Item], *,
           article_min: float, article_k: int,
           community_min: float, community_k: int) -> Cluster:
    """센트로이드로 전수 내적. 시드에 있는 id 는 제외."""
    seed_ids = cluster.seed_ids
    scored: list[tuple[float, Item]] = []
    for it in pool:
        if it.id in seed_ids:
            continue
        scored.append((dot(cluster.centroid, it.vec), it))
    scored.sort(key=lambda x: x[0], reverse=True)

    retrieved: list[Hit] = []
    community: list[Hit] = []
    for sim, it in scored:
        if it.source_kind == "community":
            if sim >= community_min and len(community) < community_k:
                community.append(Hit(it, sim, "community"))
        else:
            if sim >= article_min and len(retrieved) < article_k:
                retrieved.append(Hit(it, sim, "retrieved"))
        if len(retrieved) >= article_k and len(community) >= community_k:
            break
    cluster.retrieved = retrieved
    cluster.community = community
    return cluster


def claimed_hits(cluster: Cluster, *, consumed: set[int] | None = None) -> list[Hit]:
    """스토리에 귀속시킬 항목. 이미 소비된 것은 빼서 다른 스토리를 훔치지 않는다."""
    skip = consumed or set()
    out: list[Hit] = []
    for s in cluster.seeds:
        if s.id not in skip:
            out.append(Hit(s, 1.0, "seed"))
    for h in cluster.retrieved:
        if h.similarity >= CLAIM_RETRIEVED and h.item.id not in skip:
            out.append(h)
    for h in cluster.community:
        if h.similarity >= CLAIM_COMMUNITY and h.item.id not in skip:
            out.append(h)
    return out
