from __future__ import annotations

from pathlib import Path

import pytest

from writer.db import connect, init_db, utcnow
from writer.settings import Settings
from writer.vec import normalize, pack

WRITER_ROOT = Path(__file__).resolve().parents[1]
COLLECTOR_SCHEMA = WRITER_ROOT.parent / "collector" / "db" / "schema.sql"
WRITER_SCHEMA = WRITER_ROOT / "db" / "schema.sql"
PROMPTS = WRITER_ROOT / "config" / "prompts.yaml"
MODEL = "m"


def v(*xs: float) -> bytes:
    return pack(normalize([float(x) for x in xs]))


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "news.db")
    c.raw.executescript(COLLECTOR_SCHEMA.read_text(encoding="utf-8"))
    init_db(c, WRITER_SCHEMA)
    yield c
    c.close()


def make_settings(tmp_path, **kw) -> Settings:
    base = dict(
        db_path=tmp_path / "news.db",
        schema_file=WRITER_SCHEMA,
        prompts_file=PROMPTS,
        out_dir=tmp_path / "out",
        embed_model=MODEL,
        interval=10800,
        lookback_hours=36,
        rag_window_hours=168,
        merge_days=14,
        sim_threshold=0.72,
        rag_article_min=0.65,
        rag_community_min=0.70,
        merge_followup=0.80,
        merge_related=0.70,
        rag_article_k=8,
        rag_community_k=3,
        min_singleton_desc=200,
        min_singleton_weight=1.0,
        max_per_run=0,
        batch_limit=100,
        web_url="",
        web_api_key="",
        openrouter_base="https://or/api/v1",
        openrouter_api_key="secret",
        writer_model="test/writer",
        editor_model="test/editor",
        bench_models="test/a,test/b",
        max_tokens=400,
        timeout=30.0,
        min_interval=0.0,
        temperature=0.2,
        reasoning_effort="low",
    )
    base.update(kw)
    return Settings(**base)


def add_source(conn, name: str, *, kind: str = "article", weight: float = 1.0) -> int:
    # collector 가 넣는 행 — 가드 우회는 테스트 픽스처만.
    cur = conn.raw.execute(
        "INSERT INTO sources (name, feed_url, type, kind, enabled, weight, lang, created_at) "
        "VALUES (?, ?, 'rss', ?, 1, ?, 'en', ?)",
        (name, f"https://{name.replace(' ', '').lower()}.example/feed", kind, weight, utcnow()),
    )
    return int(cur.lastrowid)


def add_item(conn, source_id: int, title: str, *, desc: str = "x" * 80,
             vec=None, status: str = "embedded",
             url: str | None = None, content: str = "") -> int:
    url = url or f"https://e.example/{abs(hash(title))}"
    now = utcnow()
    cur = conn.raw.execute(
        "INSERT INTO raw_items (source_id, url, canonical_url, url_hash, title, description, "
        "content, published_at, fetched_at, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (source_id, url, url, str(abs(hash(url))), title, desc, content or None, now, now, status),
    )
    item_id = int(cur.lastrowid)
    blob = vec if vec is not None else v(1, 0, 0, 0)
    conn.raw.execute(
        "INSERT INTO item_embeddings (raw_item_id, model, dim, vec, text_hash, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (item_id, MODEL, 4, blob, "h", now),
    )
    return item_id
