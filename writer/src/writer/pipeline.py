"""한 주기: 묶기 → RAG → 선별/병합 → (선택) 글쓰기. collector 테이블은 읽기만."""

from __future__ import annotations

import logging
from pathlib import Path

from . import store
from .agents import load_prompts, prompt_version, run_writer
from .assign import has_body_material, prepare, should_write
from .cluster import claimed_hits, cluster_articles, expand
from .db import Conn, consumed_ids, iso_days_ago, iso_hours_ago, load_batch, load_recent_stories, load_window, utcnow
from .llm import OpenRouterChat
from .models import Cluster, Hit, Prepared, StoryRow
from .pack import build_pack, source_lines
from .publish import ascii_slug, ingest_payload, post_article, render_markdown, write_file
from .publish import unescape_newlines
from .settings import Settings

log = logging.getLogger(__name__)


def build_prepared(conn: Conn, settings: Settings, *,
                   lookback: int | None = None,  # 무시됨. CLI 호환
                   limit: int | None = None) -> tuple[list, list[Prepared]]:
    after_id = store.get_intake_after_id(conn)
    batch = limit if limit is not None else settings.batch_limit
    candidates = load_batch(conn, settings.embed_model, after_id=after_id, limit=batch)
    window = load_window(conn, settings.embed_model, iso_hours_ago(settings.rag_window_hours))
    existing = load_recent_stories(conn, iso_days_ago(settings.merge_days))
    clusters = cluster_articles(candidates, settings.sim_threshold)
    prepared: list[Prepared] = []
    for c in clusters:
        expand(
            c, window,
            article_min=settings.rag_article_min, article_k=settings.rag_article_k,
            community_min=settings.rag_community_min, community_k=settings.rag_community_k,
        )
        prepared.append(prepare(
            c, existing,
            min_weight=settings.min_singleton_weight,
            min_desc=settings.min_singleton_desc,
            followup=settings.merge_followup,
            related=settings.merge_related,
        ))
    return candidates, prepared


def format_plan(prepared: list[Prepared]) -> str:
    lines = [f"# writer plan — {len(prepared)}개 클러스터", ""]
    for i, p in enumerate(prepared, 1):
        rel = f" {p.relation}@{p.relation_score:.3f}→#{p.existing.id}" if p.relation and p.existing else ""
        lines.append(
            f"## {i}. {p.decision}  imp={p.importance:.2f}  seeds={len(p.cluster.seeds)}"
            f"  retrieved={len(p.cluster.retrieved)}  community={len(p.cluster.community)}{rel}"
        )
        if p.skip_reason:
            lines.append(f"- skip: {p.skip_reason}")
        for s in p.cluster.seeds:
            lines.append(f"- [{s.source_name}] {s.title[:80]}")
        for h in p.cluster.retrieved[:5]:
            lines.append(f"  · retrieved {h.similarity:.3f} [{h.item.source_name}] {h.item.title[:70]}")
        for h in p.cluster.community:
            lines.append(f"  · community {h.similarity:.3f} [{h.item.source_name}] {h.item.title[:70]}")
        lines.append("")
    return "\n".join(lines)


def persist_prepared(conn: Conn, settings: Settings, prepared: list[Prepared],
                     run_id: int | None) -> dict:
    """클러스터를 DB 에 반영. LLM 은 호출하지 않는다.

    같은 주기 안에서 새로 생긴 스토리도 이후 클러스터의 병합 대상이 된다.
    """
    existing = load_recent_stories(conn, iso_days_ago(settings.merge_days))
    consumed = consumed_ids(conn)
    stats = {"stories_new": 0, "stories_updated": 0, "claimed": 0}

    for p in prepared:
        if p.decision == "skip" and (p.skip_reason or "").startswith("한도"):
            continue
        if p.decision == "merge" and p.existing is not None:
            story_id = p.existing.id
            hits = claimed_hits(p.cluster, consumed=consumed)
            added = store.attach_hits(conn, story_id, hits, run_id, consumed)
            stats["claimed"] += len(added)
            cvec = store.refresh_story_centroid(conn, story_id, settings.embed_model)
            writeable, _ = should_write(
                p.cluster,
                min_weight=settings.min_singleton_weight,
                min_desc=settings.min_singleton_desc,
            )
            st = store.load_story(conn, story_id)
            if st and st.status == "skipped" and (st.source_count >= 2 or writeable):
                store.update_story_status(conn, story_id, "clustered", skip_reason="")
            elif st and st.status in ("published", "edited", "drafted", "written") and any(h.role == "seed" for h in added):
                store.update_story_status(conn, story_id, "clustered")
            _refresh_existing(existing, story_id, cvec)
            stats["stories_updated"] += 1
            continue

        slug_base = ascii_slug(p.cluster.seeds[0].title if p.cluster.seeds else "story")
        story_id = store.insert_story(conn, p)
        store.update_story_status(
            conn, story_id, "skipped" if p.decision == "skip" else "clustered",
            slug=f"{slug_base}-{story_id}",
        )
        hits = claimed_hits(p.cluster, consumed=consumed)
        added = store.attach_hits(conn, story_id, hits, run_id, consumed)
        stats["claimed"] += len(added)
        if p.relation == "related" and p.existing is not None:
            store.insert_relation(conn, story_id, p.existing.id, "related", p.relation_score)
        row = store.load_story(conn, story_id)
        if row:
            existing.append(row)
        stats["stories_new"] += 1
    return stats


def _refresh_existing(existing: list[StoryRow], story_id: int, cvec: list[float]) -> None:
    for st in existing:
        if st.id == story_id:
            st.centroid = cvec
            return


def _hits_to_cluster(hits: list[Hit]) -> Cluster:
    seeds = [h.item for h in hits if h.role == "seed"]
    if not seeds:
        seeds = [h.item for h in hits if h.role != "community"]
    from .vec import centroid as _centroid
    cvec = _centroid([h.item.vec for h in hits]) if hits else []
    cl = Cluster(seeds=seeds or [hits[0].item], centroid=cvec) if hits else Cluster(seeds=[], centroid=[])
    cl.retrieved = [h for h in hits if h.role == "retrieved"]
    cl.community = [h for h in hits if h.role == "community"]
    return cl


def write_story(conn: Conn, settings: Settings, chat: OpenRouterChat, *,
                story_id: int, run_id: int | None,
                prompts: dict, pver: str) -> Path | None:
    st = store.load_story(conn, story_id)
    if st is None:
        raise RuntimeError(f"story 없음: {story_id}")
    hits = store.load_story_hits(conn, story_id, settings.embed_model)
    if not hits:
        raise RuntimeError(f"story {story_id} 에 소스가 없다")
    cluster = _hits_to_cluster(hits)
    pack = build_pack(cluster)
    sources = source_lines(hits)

    if st.status == "published":
        row = conn.execute(
            "SELECT title_ko, lede_ko, body_md, model FROM articles WHERE story_id=? "
            "ORDER BY id DESC LIMIT 1",
            (story_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"story {story_id} 의 기사가 없다")
        title, lede, body, model_name = row["title_ko"], row["lede_ko"], row["body_md"], row["model"]
        section = ""
    else:
        w = run_writer(
            chat, prompts, pack,
            model=settings.writer_model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
        )
        store.insert_usage(conn, run_id=run_id, story_id=story_id, role="writer", result=w)
        title = unescape_newlines(str(w.data.get("title_ko") or "")).strip()
        lede = unescape_newlines(str(w.data.get("lede_ko") or "")).strip()
        body = unescape_newlines(str(w.data.get("body_md") or "")).strip()
        section = str(w.data.get("section") or "").strip()
        if not title or not body:
            raise RuntimeError(f"writer 응답 필드 부족: {w.data!r}"[:300])
        store.insert_article(
            conn, story_id=story_id, run_id=run_id, stage="written",
            model=w.model, prompt_version=pver, title_ko=title, lede_ko=lede, body_md=body,
        )
        model_name = w.model

    slug = st.slug or f"s{story_id}"
    date = utcnow()[:10]
    text = render_markdown(
        story_id=story_id, slug=slug, title=title, lede=lede, body=body,
        model=model_name, run_id=run_id, sources=sources, status="published",
        prompt_version=pver,
    )
    path = write_file(settings.out_dir, date=date, slug=slug, text=text)
    store.update_story_status(conn, story_id, "published", title_ko=title, lede_ko=lede)
    if settings.web_url:
        payload = ingest_payload(
            slug=slug, title=title, lede=lede, body_md=body,
            section=section,
            published_at=utcnow(), story_id=story_id, sources=sources,
        )
        try:
            code = post_article(settings.web_url, settings.web_api_key, payload)
            log.info("웹 ingest %s → HTTP %s", slug, code)
        except Exception as exc:  # noqa: BLE001
            log.warning("웹 ingest 실패 (로컬은 저장됨): %s", exc)
    log.info("발행: %s", path)
    return path


def run_once(conn: Conn, settings: Settings, *, lookback: int | None = None,
             limit: int | None = None,
             dry_run: bool = False, write: bool = True,
             chat: OpenRouterChat | None = None,
             should_stop=None) -> dict:
    candidates, prepared = build_prepared(conn, settings, lookback=lookback, limit=limit)
    plan = format_plan(prepared)
    if dry_run:
        return {
            "dry_run": True,
            "items_seen": len(candidates),
            "clusters": len(prepared),
            "write": sum(1 for p in prepared if p.decision == "write"),
            "skip": sum(1 for p in prepared if p.decision == "skip"),
            "merge": sum(1 for p in prepared if p.decision == "merge"),
            "intake_after_id": store.get_intake_after_id(conn),
            "plan": plan,
        }

    run_id = store.start_run(conn)
    error = None
    articles = 0
    persist_stats = {"stories_new": 0, "stories_updated": 0, "claimed": 0}
    try:
        persist_stats = persist_prepared(conn, settings, prepared, run_id)
        mark = store.advance_intake(conn, [c.id for c in candidates])
        persist_stats["intake_after_id"] = mark
        if write:
            if chat is None:
                raise RuntimeError("write=True 인데 OpenRouter 클라이언트가 없다")
            prompts = load_prompts(settings.prompts_file)
            pver = prompt_version(settings.prompts_file)
            pending = store.pending_write_ids(conn)
            for i, sid in enumerate(pending, 1):
                if should_stop and should_stop():
                    log.info("중단 — 남은 %d편은 다음 주기", len(pending) - i + 1)
                    break
                log.info("쓰기 %d/%d story=%s", i, len(pending), sid)
                hits = store.load_story_hits(conn, sid, settings.embed_model)
                if not has_body_material(_hits_to_cluster(hits)):
                    store.update_story_status(conn, sid, "skipped", skip_reason="제목만")
                    log.info("건너뜀(제목만): story=%s", sid)
                    continue
                try:
                    write_story(conn, settings, chat, story_id=sid, run_id=run_id,
                                prompts=prompts, pver=pver)
                    articles += 1
                except Exception as exc:  # noqa: BLE001
                    log.error("story %s 쓰기 실패: %s", sid, exc)
        store.finish_run(
            conn, run_id, status="ok", items_seen=len(candidates),
            stories_new=persist_stats["stories_new"],
            stories_updated=persist_stats["stories_updated"],
            articles_written=articles,
        )
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        store.finish_run(
            conn, run_id, status="error", items_seen=len(candidates),
            stories_new=persist_stats["stories_new"],
            stories_updated=persist_stats["stories_updated"],
            articles_written=articles, error=error,
        )
        raise
    return {
        "dry_run": False,
        "run_id": run_id,
        "items_seen": len(candidates),
        "clusters": len(prepared),
        "plan": plan,
        **persist_stats,
        "articles_written": articles,
    }
