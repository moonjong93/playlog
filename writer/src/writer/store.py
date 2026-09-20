"""writer 테이블 쓰기. collector 테이블은 여기 쿼리에 넣지 않는다."""

from __future__ import annotations

from .cluster import claimed_hits
from .db import Conn, utcnow
from .models import Cluster, Hit, Prepared, StoryRow
from .vec import centroid, pack, unpack


INTAKE_KEY = "intake_after_id"


def get_intake_after_id(conn: Conn) -> int | None:
    row = conn.execute(
        "SELECT value FROM writer_meta WHERE key=?", (INTAKE_KEY,)
    ).fetchone()
    if row is None or row["value"] in (None, ""):
        return None
    try:
        return int(row["value"])
    except ValueError:
        return None


def set_intake_after_id(conn: Conn, item_id: int) -> None:
    conn.execute(
        """
        INSERT INTO writer_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (INTAKE_KEY, str(item_id)),
    )


def advance_intake(conn: Conn, item_ids: list[int]) -> int | None:
    if not item_ids:
        return get_intake_after_id(conn)
    nxt = max(item_ids)
    set_intake_after_id(conn, nxt)
    return nxt


def start_run(conn: Conn) -> int:
    cur = conn.execute(
        "INSERT INTO writer_runs (started_at, status) VALUES (?, 'running')",
        (utcnow(),),
    )
    return int(cur.lastrowid)


def finish_run(conn: Conn, run_id: int, *, status: str, items_seen: int,
               stories_new: int, stories_updated: int, articles_written: int,
               error: str | None = None) -> None:
    conn.execute(
        """
        UPDATE writer_runs
           SET finished_at=?, status=?, items_seen=?, stories_new=?,
               stories_updated=?, articles_written=?, error=?
         WHERE id=?
        """,
        (utcnow(), status, items_seen, stories_new, stories_updated,
         articles_written, error, run_id),
    )


def _window(cluster: Cluster) -> tuple[str | None, str | None]:
    times = [s.published_at or s.fetched_at for s in cluster.seeds]
    times = [t for t in times if t]
    if not times:
        return None, None
    return min(times), max(times)


def _source_counts(hits: list[Hit]) -> tuple[int, int]:
    article_src = {h.item.source_id for h in hits if h.role != "community"}
    comm = sum(1 for h in hits if h.role == "community")
    return len(article_src), comm


def insert_story(conn: Conn, prepared: Prepared) -> int:
    now = utcnow()
    ws, we = _window(prepared.cluster)
    hits = claimed_hits(prepared.cluster)
    nsrc, ncomm = _source_counts(hits)
    status = "skipped" if prepared.decision == "skip" else "clustered"
    cur = conn.execute(
        """
        INSERT INTO stories (
            status, skip_reason, window_start, window_end,
            source_count, community_count, importance, centroid_blob,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (status, prepared.skip_reason, ws, we, nsrc, ncomm,
         prepared.importance, pack(prepared.cluster.centroid), now, now),
    )
    return int(cur.lastrowid)


def attach_hits(conn: Conn, story_id: int, hits: list[Hit], run_id: int | None,
                consumed: set[int]) -> list[Hit]:
    """아직 소비되지 않은 hit 만 story_sources + writing_items 에 넣는다."""
    now = utcnow()
    added = []
    for h in hits:
        if h.item.id in consumed:
            continue
        conn.execute(
            """
            INSERT OR IGNORE INTO story_sources (story_id, raw_item_id, role, similarity)
            VALUES (?, ?, ?, ?)
            """,
            (story_id, h.item.id, h.role, h.similarity),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO writing_items
                (raw_item_id, story_id, run_id, role, similarity, claimed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (h.item.id, story_id, run_id, h.role, h.similarity, now),
        )
        consumed.add(h.item.id)
        added.append(h)
    return added


def insert_relation(conn: Conn, from_id: int, to_id: int, kind: str, score: float) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO story_relations (from_id, to_id, kind, score)
        VALUES (?, ?, ?, ?)
        """,
        (from_id, to_id, kind, score),
    )


def refresh_story_centroid(conn: Conn, story_id: int, model: str) -> list[float]:
    """story_sources 의 벡터를 다시 평균. item_embeddings 는 읽기만."""
    rows = conn.execute(
        """
        SELECT e.vec FROM story_sources ss
          JOIN item_embeddings e ON e.raw_item_id = ss.raw_item_id AND e.model = ?
         WHERE ss.story_id = ?
        """,
        (model, story_id),
    ).fetchall()
    vecs = [unpack(r["vec"]) for r in rows]
    cvec = centroid(vecs)
    nsrc = conn.execute(
        """
        SELECT COUNT(DISTINCT ri.source_id) c
          FROM story_sources ss
          JOIN raw_items ri ON ri.id = ss.raw_item_id
          JOIN sources s ON s.id = ri.source_id
         WHERE ss.story_id = ? AND ss.role != 'community' AND s.kind = 'article'
        """,
        (story_id,),
    ).fetchone()["c"]
    ncomm = conn.execute(
        "SELECT COUNT(*) c FROM story_sources WHERE story_id=? AND role='community'",
        (story_id,),
    ).fetchone()["c"]
    conn.execute(
        """
        UPDATE stories
           SET centroid_blob=?, source_count=?, community_count=?, updated_at=?
         WHERE id=?
        """,
        (pack(cvec) if cvec else None, nsrc, ncomm, utcnow(), story_id),
    )
    return cvec


def update_story_status(conn: Conn, story_id: int, status: str, *,
                        title_ko: str | None = None, lede_ko: str | None = None,
                        skip_reason: str | None = None,
                        needs_review: int | None = None,
                        slug: str | None = None) -> None:
    fields = ["status=?", "updated_at=?"]
    params: list = [status, utcnow()]
    if title_ko is not None:
        fields.append("title_ko=?")
        params.append(title_ko)
    if lede_ko is not None:
        fields.append("lede_ko=?")
        params.append(lede_ko)
    if skip_reason is not None:
        fields.append("skip_reason=?")
        params.append(skip_reason)
    if needs_review is not None:
        fields.append("needs_review=?")
        params.append(needs_review)
    if slug is not None:
        fields.append("slug=?")
        params.append(slug)
    params.append(story_id)
    conn.execute(f"UPDATE stories SET {', '.join(fields)} WHERE id=?", params)


def insert_article(conn: Conn, *, story_id: int, run_id: int | None, stage: str,
                   model: str, prompt_version: str,
                   title_ko: str, lede_ko: str, body_md: str) -> int:
    cur = conn.execute(
        """
        INSERT INTO articles (story_id, run_id, stage, model, prompt_version,
                              title_ko, lede_ko, body_md, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (story_id, run_id, stage, model, prompt_version,
         title_ko, lede_ko or "", body_md, utcnow()),
    )
    return int(cur.lastrowid)


def insert_usage(conn: Conn, *, run_id: int | None, story_id: int | None,
                 role: str, result) -> None:
    conn.execute(
        """
        INSERT INTO llm_usage (run_id, story_id, role, model, prompt_tokens,
                               completion_tokens, cost_usd, request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, story_id, role, result.model, result.prompt_tokens,
         result.completion_tokens, result.cost_usd, result.request_id, utcnow()),
    )


def load_story(conn: Conn, story_id: int) -> StoryRow | None:
    r = conn.execute(
        """
        SELECT id, slug, status, skip_reason, centroid_blob, source_count, community_count
          FROM stories WHERE id=?
        """,
        (story_id,),
    ).fetchone()
    if r is None:
        return None
    blob = r["centroid_blob"]
    return StoryRow(
        id=r["id"], slug=r["slug"], status=r["status"], skip_reason=r["skip_reason"],
        centroid=unpack(blob) if blob else [],
        source_count=r["source_count"], community_count=r["community_count"],
    )


def load_story_hits(conn: Conn, story_id: int, model: str) -> list[Hit]:
    """발행용 소스팩. 소비 여부와 관계없이 이 스토리에 붙은 항목."""
    from .models import Item
    from .vec import unpack as _unpack
    rows = conn.execute(
        """
        SELECT ri.id, ri.source_id, ri.url, ri.title, ri.description, ri.content,
               ri.published_at, ri.fetched_at,
               s.name AS source_name, s.kind AS source_kind, s.weight AS source_weight,
               e.vec, ss.role, ss.similarity
          FROM story_sources ss
          JOIN raw_items ri ON ri.id = ss.raw_item_id
          JOIN sources s ON s.id = ri.source_id
          JOIN item_embeddings e ON e.raw_item_id = ri.id AND e.model = ?
         WHERE ss.story_id = ?
         ORDER BY CASE ss.role WHEN 'seed' THEN 0 WHEN 'retrieved' THEN 1 ELSE 2 END,
                  ss.similarity DESC
        """,
        (model, story_id),
    )
    hits = []
    for r in rows:
        item = Item(
            id=r["id"], source_id=r["source_id"], source_name=r["source_name"],
            source_kind=r["source_kind"], source_weight=r["source_weight"],
            url=r["url"], title=r["title"], description=r["description"] or "",
            content=r["content"] or "", published_at=r["published_at"],
            fetched_at=r["fetched_at"], vec=_unpack(r["vec"]),
        )
        hits.append(Hit(item, r["similarity"], r["role"]))
    return hits


def pending_write_ids(conn: Conn) -> list[int]:
    rows = conn.execute(
        """
        SELECT id FROM stories
         WHERE status IN ('clustered', 'drafted', 'edited')
           AND (skip_reason IS NULL OR skip_reason = '')
         ORDER BY importance DESC, id
        """
    )
    return [r["id"] for r in rows]
