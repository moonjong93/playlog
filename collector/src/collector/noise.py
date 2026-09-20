"""노이즈 1차 필터 — 규칙만. LLM 없음.

삭제하지 않는다. status='filtered' + noise_reason 만 남긴다.
writer 가 근거를 보고 되살릴 수 있어야 하기 때문.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

log = logging.getLogger(__name__)


@dataclass
class NoiseRules:
    allow_sources: list[str]
    title_allow: list[re.Pattern]
    title_deny: list[tuple[str, re.Pattern]]

    @classmethod
    def load(cls, path: Path) -> "NoiseRules":
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        allow_sources = [str(s) for s in (data.get("allow_sources") or [])]
        allow = [re.compile(p) for p in (data.get("title_allow") or [])]
        deny = []
        for item in data.get("title_deny") or []:
            if isinstance(item, dict) and item.get("pattern"):
                deny.append((str(item.get("name") or "deny"), re.compile(str(item["pattern"]))))
        return cls(allow_sources=allow_sources, title_allow=allow, title_deny=deny)

    def classify(self, source_name: str, title: str, description: str) -> str | None:
        """filtered 사유 이름 또는 None(보존).

        deny 는 **제목만** 본다. 요약까지 보면 요약에 'movie' 한 단어만 있어도
        게임 기사가 걸러진다(실측 오탐). allow 는 구제용이라 제목+요약을 모두 본다.
        """
        if source_name in self.allow_sources:
            return None
        if any(p.search(f"{title}\n{description or ''}") for p in self.title_allow):
            return None
        for name, pattern in self.title_deny:
            if pattern.search(title):
                return name
        return None


def apply_rules(conn, rules: NoiseRules, *, limit: int | None = None) -> dict:
    sql = """
        SELECT ri.id, ri.title, ri.description, s.name AS source
          FROM raw_items ri JOIN sources s ON s.id = ri.source_id
         WHERE ri.status = 'new'
         ORDER BY ri.id
    """
    if limit:
        sql += " LIMIT ?"
        rows = conn.execute(sql, (limit,)).fetchall()
    else:
        rows = conn.execute(sql).fetchall()

    stats: dict = {"scanned": 0, "filtered": 0, "kept": 0, "reasons": {}}
    for row in rows:
        stats["scanned"] += 1
        reason = rules.classify(row["source"], row["title"], row["description"])
        if reason:
            conn.execute(
                "UPDATE raw_items SET status='filtered', noise_reason=? WHERE id=?",
                (reason, row["id"]),
            )
            stats["filtered"] += 1
            stats["reasons"][reason] = stats["reasons"].get(reason, 0) + 1
        else:
            stats["kept"] += 1
    log.info("noise: 검사 %d → 보존 %d, 제외 %d %s",
             stats["scanned"], stats["kept"], stats["filtered"], stats["reasons"] or "")
    return stats
