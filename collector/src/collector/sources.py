"""sources.yaml <-> sources 테이블 동기화."""

from __future__ import annotations

from pathlib import Path

import yaml

from .db import utcnow


def load_source_defs(path: Path) -> list[dict]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    defs = []
    for item in data.get("sources") or []:
        if not item.get("feed_url") or not item.get("name"):
            continue
        defs.append(
            {
                "name": str(item["name"]).strip(),
                "feed_url": str(item["feed_url"]).strip(),
                "type": str(item.get("type", "rss")),
                "kind": str(item.get("kind", "article")).strip() or "article",
                "weight": float(item.get("weight", 1.0)),
                "lang": str(item.get("lang", "en")),
                "user_agent": (str(item["user_agent"]).strip() if item.get("user_agent") else None),
                "impersonate": (str(item["impersonate"]).strip() if item.get("impersonate") else None),
                "enabled": 1 if item.get("enabled", True) else 0,
            }
        )
    return defs


def sync_sources(conn, path: Path) -> dict[str, int]:
    """feed_url 기준 upsert. enabled 를 포함해 yaml 을 그대로 반영한다.

    yaml 에서 사라진 피드도 enabled=0 으로 내린다.
    """
    defs = load_source_defs(path)
    created = updated = 0
    now = utcnow()
    for d in defs:
        row = conn.execute("SELECT id FROM sources WHERE feed_url = ?", (d["feed_url"],)).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO sources
                    (name, feed_url, type, kind, enabled, weight, lang,
                     user_agent, impersonate, created_at)
                VALUES (:name, :feed_url, :type, :kind, :enabled, :weight, :lang,
                        :user_agent, :impersonate, :created_at)
                """,
                {**d, "created_at": now},
            )
            created += 1
        else:
            conn.execute(
                """
                UPDATE sources
                   SET name = :name, type = :type, kind = :kind, weight = :weight,
                       lang = :lang, user_agent = :user_agent, impersonate = :impersonate,
                       enabled = :enabled
                 WHERE id = :id
                """,
                {**d, "id": row["id"]},
            )
            updated += 1

    disabled = 0
    if defs:
        marks = ",".join("?" for _ in defs)
        cur = conn.execute(
            f"UPDATE sources SET enabled = 0 WHERE enabled = 1 AND feed_url NOT IN ({marks})",
            tuple(d["feed_url"] for d in defs),
        )
        disabled = cur.rowcount
    return {"created": created, "updated": updated, "total": len(defs), "disabled": disabled}


def list_sources(conn, enabled_only: bool = False):
    sql = "SELECT * FROM sources"
    if enabled_only:
        sql += " WHERE enabled = 1"
    sql += " ORDER BY weight DESC, name"
    return conn.execute(sql).fetchall()


def resolve_source(conn, ref: str):
    if ref.isdigit():
        row = conn.execute("SELECT * FROM sources WHERE id = ?", (int(ref),)).fetchone()
        if row:
            return row
    return conn.execute("SELECT * FROM sources WHERE name = ? COLLATE NOCASE", (ref,)).fetchone()
