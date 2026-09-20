"""하루 돌려보고 검증하기 위한 지표 리포트."""

from __future__ import annotations

from datetime import datetime, timezone

from . import embed as embed_mod


def build_report(conn, model: str, *, hours: int = 24, sim_sample: int = 300,
                 threshold: float = 0.72) -> str:
    from .db import counts

    out: list[str] = []
    now = datetime.now(timezone.utc)
    out.append(f"# collector 리포트 — {now:%Y-%m-%d %H:%M} UTC (최근 {hours}시간)")
    out.append("")

    # 1) 저장 현황
    out.append("## 1. 저장 현황")
    for t, c in counts(conn).items():
        out.append(f"- {t}: **{c:,}**")
    size = conn.execute("PRAGMA page_count").fetchone()[0] * conn.execute("PRAGMA page_size").fetchone()[0]
    out.append(f"- DB 크기: {size / 1048576:.1f} MB")
    out.append("")

    # 2) 상태 분포
    out.append("## 2. raw_items 상태 (writer 관점)")
    total = 0
    for row in conn.execute("SELECT status, COUNT(*) c FROM raw_items GROUP BY status ORDER BY c DESC"):
        out.append(f"- {row['status']}: {row['c']:,}")
        total += row["c"]
    ready = conn.execute("SELECT COUNT(*) c FROM raw_items WHERE status='embedded'").fetchone()["c"]
    out.append(f"- **writer 에 넘길 수 있는 건수(embedded): {ready:,} / {total:,} "
               f"({ready / total * 100 if total else 0:.1f}%)**")
    out.append("")

    # 3) 수집 성과
    out.append(f"## 3. 수집 (최근 {hours}시간)")
    row = conn.execute(
        """
        SELECT COUNT(*) feeds, SUM(new_items) new_items, SUM(duplicate) dup,
               SUM(entries) entries,
               SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) errors
          FROM source_fetches WHERE started_at >= datetime('now', ?)
        """,
        (f"-{hours} hours",),
    ).fetchone()
    feeds = row["feeds"] or 0
    out.append(f"- 실행 {feeds:,}회 → 신규 {row['new_items'] or 0:,}건 / 중복 {row['dup'] or 0:,}건 "
               f"/ 수집항목 {row['entries'] or 0:,}건")
    out.append(f"- 실패 {row['errors'] or 0:,}회 (성공률 {(1 - (row['errors'] or 0) / feeds) * 100 if feeds else 0:.0f}%)")
    out.append("")
    out.append("### 피드별 (최근 24시간)")
    for r in conn.execute(
        """
        SELECT s.name, COUNT(f.id) runs, SUM(f.new_items) new_items,
               MAX(f.started_at) last, MAX(COALESCE(f.error, '')) err
          FROM sources s LEFT JOIN source_fetches f ON f.source_id = s.id
         WHERE s.enabled = 1 GROUP BY s.id ORDER BY new_items DESC NULLS LAST LIMIT 25
        """
    ):
        flag = " ⚠️" if r["err"] else ""
        out.append(f"- {r['name']}: 신규 {r['new_items'] or 0:,} / 실행 {r['runs'] or 0} / 마지막 {r['last'] or '-'}{flag}")
    out.append("")

    # 4) 노이즈 필터
    out.append("## 4. 노이즈 필터")
    nf = conn.execute("SELECT COUNT(*) c FROM raw_items WHERE status='filtered'").fetchone()["c"]
    out.append(f"- 제외 {nf:,}건 ({(nf / total * 100) if total else 0:.1f}%)")
    for r in conn.execute(
        "SELECT noise_reason, COUNT(*) c FROM raw_items WHERE status='filtered' "
        "GROUP BY noise_reason ORDER BY c DESC"
    ):
        out.append(f"  - {r['noise_reason']}: {r['c']:,}")
    out.append("")

    # 5) 분포
    out.append("## 5. 분포")
    out.append("### 언어")
    for r in conn.execute(
        "SELECT s.lang, COUNT(*) c FROM raw_items ri JOIN sources s ON s.id = ri.source_id "
        "GROUP BY s.lang ORDER BY c DESC"
    ):
        out.append(f"- {r['lang']}: {r['c']:,}")
    out.append("### kind")
    for r in conn.execute(
        "SELECT s.kind, COUNT(*) c FROM raw_items ri JOIN sources s ON s.id = ri.source_id "
        "GROUP BY s.kind ORDER BY c DESC"
    ):
        out.append(f"- {r['kind']}: {r['c']:,}")
    out.append(f"### 커뮤니티 댓글 저장된 글")
    with_comments = conn.execute("SELECT COUNT(*) c FROM raw_items WHERE content IS NOT NULL").fetchone()["c"]
    out.append(f"- {with_comments:,}건")
    out.append("")

    # 5-1) 본문/요약 커버리지 — writer 가 실제로 읽을 재료가 얼마나 되는지
    out.append("### 요약(본문 대체) 커버리지")
    desc = conn.execute(
        "SELECT COUNT(*) n, AVG(LENGTH(description)) a, MAX(LENGTH(description)) m "
        "FROM raw_items WHERE COALESCE(description,'') <> ''"
    ).fetchone()
    clipped = conn.execute("SELECT COUNT(*) c FROM raw_items WHERE LENGTH(description) >= 3990").fetchone()["c"]
    out.append(f"- RSS 요약 보유 {desc['n']:,}건 ({(desc['n'] / total * 100) if total else 0:.0f}%)"
               f" / 평균 {desc['a'] or 0:.0f}자 · 최대 {desc['m'] or 0:,}자")
    out.append(f"- 요약이 4000자 상한에 걸려 잘린 건 {clipped:,}건")
    out.append(f"- 본문(content) 보유 {with_comments:,}건 — 지금은 Reddit 댓글 전용이다. **기사 본문은 수집하지 않는다**")
    out.append("### 소스별 평균 요약 길이")
    for r in conn.execute(
        """SELECT s.name, COUNT(*) n, AVG(LENGTH(COALESCE(ri.description,''))) L
             FROM raw_items ri JOIN sources s ON s.id = ri.source_id
            GROUP BY s.id ORDER BY L DESC"""
    ):
        out.append(f"- {r['name']}: {r['L']:.0f}자 (n={r['n']:,})")
    out.append("")

    # 6) 임베딩 품질 (writer 묶기 재료)
    out.append("## 6. 임베딩 + 같은 사건 묶임 품질")
    emb = conn.execute(
        "SELECT COUNT(*) c, MIN(dim) d FROM item_embeddings WHERE model = ?", (model,)
    ).fetchone()
    out.append(f"- 임베딩 {emb['c'] or 0:,}건 (dim={emb['d'] or '-'}, model={model})")
    sim = embed_mod.similarity_sample(conn, model, sample=sim_sample, threshold=threshold)
    out.append(f"- 표본 {sim['items']}건 / {sim['pairs']:,}쌍 (같은 매체 쌍 제외) 유사도 분포:")
    for k, v in sim["buckets"].items():
        pct = (v / sim["pairs"] * 100) if sim["pairs"] else 0
        out.append(f"  - {k}: {v:,} ({pct:.1f}%)")
    if sim["top"]:
        out.append("- 가장 유사한 쌍 (같은 사건일 가능성):")
        for score, a, b in sim["top"]:
            ra = conn.execute("SELECT title, s.name src FROM raw_items ri "
                              "JOIN sources s ON s.id=ri.source_id WHERE ri.id=?", (a,)).fetchone()
            rb = conn.execute("SELECT title, s.name src FROM raw_items ri "
                              "JOIN sources s ON s.id=ri.source_id WHERE ri.id=?", (b,)).fetchone()
            out.append(f"  - {score:.3f} │ [{ra['src']}] {ra['title'][:44]} ║ [{rb['src']}] {rb['title'][:44]}")
        out.append(f"  → {threshold:.2f} 이상 쌍이 writer 가 실제로 묶을 후보")
    out.append("")

    # 7) 최근 수집 샘플
    out.append("## 7. 최근 수집 샘플 (embedded 우선 20건)")
    for r in conn.execute(
        """
        SELECT ri.title, s.name src, ri.status, ri.published_at
          FROM raw_items ri JOIN sources s ON s.id = ri.source_id
         WHERE ri.status IN ('embedded','new') ORDER BY ri.id DESC LIMIT 20
        """
    ):
        out.append(f"- [{r['src']}] {r['title'][:78]}  `{r['status']}`")
    out.append("")
    return "\n".join(out)
