"""선별 휴리스틱 + 기존 스토리 병합 판단. LLM 없음."""

from __future__ import annotations

import math
import re

from .cluster import CLAIM_RETRIEVED
from .models import Cluster, Prepared, StoryRow
from .vec import dot

_TAG = re.compile(r"<[^>]+>")
_URL = re.compile(r"https?://\S+")
_WORD = re.compile(r"[0-9a-z]{4,}")
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]")

# 요약이 제목과 같은 대상을 다루는지 볼 때 무시할 흔한 단어.
_STOPWORDS = {
    "that", "this", "with", "have", "from", "they", "will", "been", "were", "what",
    "when", "which", "their", "there", "about", "into", "over", "more", "than",
    "says", "said", "news", "game", "games", "gamers", "pcgamer",
}


def article_source_ids(cluster: Cluster) -> set[int]:
    ids = {s.source_id for s in cluster.seeds}
    for h in cluster.retrieved:
        if h.similarity >= CLAIM_RETRIEVED:
            ids.add(h.item.source_id)
    return ids


def _subject_tokens(text: str) -> set[str]:
    body = _URL.sub(" ", _TAG.sub(" ", text or "")).lower()
    words = {w for w in _WORD.findall(body) if w not in _STOPWORDS}
    cjk = "".join(ch for ch in body if _CJK.match(ch))
    grams = {cjk[i:i + 2] for i in range(len(cjk) - 1)}
    return words | grams


def _min_desc_len(desc: str, min_desc: int) -> int:
    """CJK(일본어·중국어) 요약은 글자당 정보량이 커서 더 짧아도 재료로 본다."""
    cjk = sum(1 for ch in desc if _CJK.match(ch))
    if desc and cjk / len(desc) >= 0.3:
        return min(min_desc, 80)
    return min_desc


def has_body_material(cluster: Cluster, *, min_desc: int = 200) -> bool:
    """제목 말고 쓸 재료가 하나라도 있는가.

    desc 가 충분히 길고(_min_desc_len) 그 소스의 제목과 같은 대상을 다뤄야 재료로 본다.
    길이만 보면 PC Gamer 처럼 기자 소개문(bio)을 summary 로 주는 피드가 통과해서,
    기사 대신 "소스팩에 본문이 없다"는 문장이 나온다.
    """
    items = list(cluster.seeds) + [h.item for h in cluster.retrieved]
    for it in items:
        if (it.content or "").strip():
            return True
        desc = (it.description or "").strip()
        if len(desc) < _min_desc_len(desc, min_desc):
            continue
        if len(_subject_tokens(it.title) & _subject_tokens(desc)) >= 2:
            return True
    return False


def should_write(cluster: Cluster, *, min_weight: float, min_desc: int) -> tuple[bool, str | None]:
    """발매 게이트가 아니다. 다만 쓸 재료가 없는 소스는 쓰지 않는다. 매체 수·weight는 importance 점수다."""
    _ = min_weight
    if not has_body_material(cluster, min_desc=min_desc):
        return False, "재료부족"
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
