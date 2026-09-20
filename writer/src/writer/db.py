"""SQLite 연결. collector 테이블에 대한 쓰기는 거절한다."""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import Item, StoryRow
from .vec import unpack

COLLECTOR_TABLES = ("sources", "raw_items", "source_fetches", "item_embeddings")
WRITER_TABLES = (
    "writer_runs", "stories", "story_sources", "story_relations",
    "writing_items", "articles", "llm_usage", "writer_meta",
    "bench_runs", "bench_cases", "bench_outputs",
)

_WRITE = re.compile(r"\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b", re.I)
_COLLECTOR = re.compile(
    r"\b(sources|raw_items|source_fetches|item_embeddings)\b", re.I,
)


def _strip_sql_comments(sql: str) -> str:
    lines = []
    for line in sql.splitlines():
        cut = line.find("--")
        lines.append(line if cut < 0 else line[:cut])
    return "\n".join(lines)


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_hours_ago(hours: int) -> str:
    from datetime import timedelta
    t = datetime.now(timezone.utc) - timedelta(hours=hours)
    return t.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_days_ago(days: int) -> str:
    return iso_hours_ago(days * 24)


def _guard(sql: str) -> None:
    body = _strip_sql_comments(sql)
    if _WRITE.search(body) and _COLLECTOR.search(body):
        raise RuntimeError(f"writer 는 collector 테이블을 수정하지 않는다: {sql[:120]}")


class Conn:
    """sqlite3.Connection 을 감싸 collector 쓰기를 막는다."""

    def __init__(self, raw: sqlite3.Connection) -> None:
        self.raw = raw

    def execute(self, sql: str, params=()):
        _guard(sql)
        return self.raw.execute(sql, params)

    def executescript(self, sql: str):
        _guard(sql)
        return self.raw.executescript(sql)

    def commit(self) -> None:
        self.raw.commit()

    def close(self) -> None:
        self.raw.close()

    def __getattr__(self, name: str):
        return getattr(self.raw, name)


def connect(db_path: Path | str) -> Conn:
    path = Path(db_path)
    if str(path.parent) not in ("", "."):
        path.parent.mkdir(parents=True, exist_ok=True)
    raw = sqlite3.connect(str(path), timeout=30.0, isolation_level=None)
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA journal_mode = WAL")
    raw.execute("PRAGMA foreign_keys = ON")
    raw.execute("PRAGMA busy_timeout = 30000")
    raw.execute("PRAGMA synchronous = NORMAL")
    return Conn(raw)


def init_db(conn: Conn, schema_file: Path) -> None:
    conn.executescript(schema_file.read_text(encoding="utf-8"))


def counts(conn: Conn) -> dict[str, int]:
    out = {}
    for t in WRITER_TABLES:
        try:
            out[t] = conn.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"]
        except sqlite3.OperationalError:
            out[t] = -1
    return out


def collector_counts(conn: Conn) -> dict[str, int]:
    out = {}
    for t in COLLECTOR_TABLES:
        try:
            out[t] = conn.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"]
        except sqlite3.OperationalError:
            out[t] = -1
    return out


def _row_to_item(r) -> Item:
    return Item(
        id=r["id"],
        source_id=r["source_id"],
        source_name=r["source_name"],
        source_kind=r["source_kind"],
        source_weight=r["source_weight"],
        url=r["url"],
        title=r["title"],
        description=r["description"] or "",
        content=r["content"] or "",
        published_at=r["published_at"],
        fetched_at=r["fetched_at"],
        vec=unpack(r["vec"]),
    )


_ITEM_SQL = """
SELECT ri.id, ri.source_id, ri.url, ri.title, ri.description, ri.content,
       ri.published_at, ri.fetched_at,
       s.name AS source_name, s.kind AS source_kind, s.weight AS source_weight,
       e.vec
  FROM raw_items ri
  JOIN sources s ON s.id = ri.source_id
  JOIN item_embeddings e ON e.raw_item_id = ri.id AND e.model = ?
 WHERE ri.status = 'embedded'
"""


def load_batch(conn: Conn, model: str, *, after_id: int | None, limit: int) -> list[Item]:
    """워터마크 다음 섭취 배치.

    after_id 없음(첫 실행): 최신 limit 건 (홈을 새 소식으로 채운다).
    after_id 있음: id > after_id 를 FIFO 로 limit 건.
    """
    if after_id is None:
        sql = _ITEM_SQL + " ORDER BY ri.id DESC LIMIT ?"
        rows = conn.execute(sql, (model, limit)).fetchall()
        items = [_row_to_item(r) for r in rows]
        items.sort(key=lambda it: it.id)
        return items
    sql = _ITEM_SQL + " AND ri.id > ? ORDER BY ri.id ASC LIMIT ?"
    return [_row_to_item(r) for r in conn.execute(sql, (model, after_id, limit))]


def load_candidates(conn: Conn, model: str, since_iso: str) -> list[Item]:
    """하위 호환. 새 코드는 load_batch 를 쓴다."""
    sql = _ITEM_SQL + """
   AND ri.fetched_at >= ?
   AND ri.id NOT IN (SELECT raw_item_id FROM writing_items)
 ORDER BY ri.id
"""
    return [_row_to_item(r) for r in conn.execute(sql, (model, since_iso))]


def load_window(conn: Conn, model: str, since_iso: str) -> list[Item]:
    """RAG 검색 공간. 이미 소비된 항목도 포함한다."""
    sql = _ITEM_SQL + " AND ri.fetched_at >= ? ORDER BY ri.id"
    return [_row_to_item(r) for r in conn.execute(sql, (model, since_iso))]


def load_recent_stories(conn: Conn, since_iso: str) -> list[StoryRow]:
    rows = conn.execute(
        """
        SELECT id, slug, status, skip_reason, centroid_blob, source_count, community_count
          FROM stories
         WHERE updated_at >= ?
         ORDER BY id
        """,
        (since_iso,),
    )
    out = []
    for r in rows:
        blob = r["centroid_blob"]
        out.append(StoryRow(
            id=r["id"], slug=r["slug"], status=r["status"],
            skip_reason=r["skip_reason"],
            centroid=unpack(blob) if blob else [],
            source_count=r["source_count"],
            community_count=r["community_count"],
        ))
    return out


def consumed_ids(conn: Conn) -> set[int]:
    return {r["raw_item_id"] for r in conn.execute("SELECT raw_item_id FROM writing_items")}


def embed_models(conn: Conn) -> list[tuple[str, int]]:
    try:
        return [(r["model"], r["c"]) for r in conn.execute(
            "SELECT model, COUNT(*) c FROM item_embeddings GROUP BY model"
        )]
    except sqlite3.OperationalError:
        return []
