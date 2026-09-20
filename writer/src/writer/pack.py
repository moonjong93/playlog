"""LLM 에 넣을 소스팩. 원문을 그대로 안 넣고 길이만 자른다."""

from __future__ import annotations

import json

from .models import Cluster, Hit, Item

MAX_SUMMARY = 1600
MAX_CONTENT = 2500
MAX_COMMENT = 280
MAX_COMMENTS = 6


def _clip(text: str, limit: int) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "…"


def parse_comments(content: str) -> list[dict]:
    raw = (content or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    rows = data.get("comments") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "author": str(row.get("author") or "").strip(),
            "text": text,
            "url": str(row.get("url") or "").strip(),
        })
        if len(out) >= MAX_COMMENTS:
            break
    return out


def _format_comments(content: str) -> str:
    comments = parse_comments(content)
    if comments:
        lines = []
        for c in comments:
            who = c["author"] or "anon"
            lines.append(f"- u/{who}: {_clip(c['text'], MAX_COMMENT)}")
        return "\n".join(lines)
    return _clip(content, MAX_CONTENT)


def _block(item: Item, *, role: str, similarity: float | None = None) -> str:
    when = item.published_at or item.fetched_at or ""
    sim = f" sim={similarity:.3f}" if similarity is not None else ""
    lines = [
        f"[{item.source_name} | {role} | {when}{sim}]",
        f"url: {item.url}",
        f"title: {item.title}",
    ]
    summary = _clip(item.description, MAX_SUMMARY)
    if summary:
        lines.append(f"summary: {summary}")
    if item.content:
        formatted = _format_comments(item.content)
        if formatted:
            lines.append("comments:")
            lines.append(formatted)
    return "\n".join(lines)


def build_pack(cluster: Cluster) -> str:
    """시드 → retrieved → community 순. 팩에 없는 사실을 모델이 못 쓰게 하는 재료."""
    parts: list[str] = []
    seeds = sorted(cluster.seeds, key=lambda s: (-s.source_weight, -s.desc_len))
    for s in seeds:
        parts.append(_block(s, role="seed"))
    for h in cluster.retrieved:
        parts.append(_block(h.item, role="retrieved", similarity=h.similarity))
    for h in cluster.community:
        parts.append(_block(h.item, role="community", similarity=h.similarity))
    return "\n\n".join(parts)


def source_lines(hits: list[Hit]) -> list[dict]:
    seen: set[int] = set()
    out = []
    for h in hits:
        if h.item.id in seen:
            continue
        seen.add(h.item.id)
        rec = {
            "id": h.item.id,
            "name": h.item.source_name,
            "url": h.item.url,
            "role": h.role,
            "similarity": round(h.similarity, 4),
        }
        if h.role == "community" and h.item.content:
            rec["comments"] = [
                {"author": c["author"], "text": _clip(c["text"], MAX_COMMENT)}
                for c in parse_comments(h.item.content)
            ]
        out.append(rec)
    return out
