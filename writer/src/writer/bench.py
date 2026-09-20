"""모델 경합. 발행 파이프(stories/articles) 는 건드리지 않는다.

같은 collector 재료를 여러 모델에 넣고, 사람 눈으로 고를 수 있게
out/bench/run-N.md 로 나란히 저장한다.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path

from .agents import load_prompts
from .db import Conn, iso_hours_ago, utcnow
from .llm import LLMResult, OpenRouterChat, parse_json_object
from .models import Cluster, Hit
from .pack import build_pack
from .settings import Settings
from .store import load_story_hits
from .vec import centroid as _centroid

log = logging.getLogger(__name__)

DEFAULT_MODELS = (
    "inclusionai/ling-3.0-flash",
    "deepseek/deepseek-v4-flash",
    "google/gemma-4-26b-a4b-it",
    "google/gemma-4-31b-it",
    "upstage/solar-pro4",
    "google/gemini-2.5-flash-lite",
    "openai/gpt-5.6-luna",
)


def parse_models(raw: str | None, fallback: str = "") -> list[str]:
    text = (raw or "").strip() or fallback
    out, seen = [], set()
    for part in text.split(","):
        name = part.strip()
        if name and name not in seen:
            out.append(name)
            seen.add(name)
    return out or list(DEFAULT_MODELS)


_LATIN_RUN = re.compile(
    r"[A-Za-z][A-Za-z0-9][A-Za-z0-9:'+.\-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9:'+.\-]*)+"
)
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def _has_cjk(text: str) -> bool:
    return bool(_CJK.search(text or ""))


def keep_terms(*parts: str) -> str:
    """로마자 게임 이름만 잠근다. 일본어 원제 전체를 넣으면 모델이 제목을 복사한다(실측)."""
    seen: set[str] = set()
    out: list[str] = []
    for part in parts:
        text = (part or "").strip()
        if not text:
            continue
        items = list(_LATIN_RUN.findall(text))
        if not _has_cjk(text):
            items = [text, *items]
        for item in items:
            s = item.strip(" 「」[](),.-")
            if s and s not in seen:
                seen.add(s)
                out.append(s)
    return "\n".join(f"- {x}" for x in out) if out else "- (로마자 고유명사 없음. 문장만 한국어로.)"


def _colon_chunks(original: str) -> list[str]:
    """'Fire Emblem: Fortune's Weave' 같은 원제 핵만 뽑는다."""
    out = []
    for m in re.finditer(r":", original):
        left = original[:m.start()].strip().split()
        right = original[m.end():].strip().split()
        l = [w.strip("()[],") for w in left[-2:] if re.match(r"^[A-Za-z]", w or "")]
        r = [w.strip("()[],") for w in right[:2] if re.match(r"^[A-Za-z0-9]", w or "")]
        if l and r:
            out.append(" ".join(l) + ": " + " ".join(r))
    return out


def missing_terms(title_ko: str, original: str) -> list[str]:
    """원제의 로마자 고유명사 중 한국어 제목에 빠진 것.

    플래그 전용이다. 제목을 고치지 않는다 — 예전엔 영어 원제면 한국어 제목을
    버리고 원문을 되돌려서, 잘 번역한 제목이 사라졌다(실측).
    영어 원제는 콜론 붙은 게임명만 본다. 헤드라인 전체를 잠그면 오탐이 쏟아진다.
    """
    ko = title_ko or ""
    orig = (original or "").strip()
    if not orig:
        return []
    chunks = _colon_chunks(orig)
    if not chunks and _has_cjk(orig):
        chunks = [c.strip() for c in _LATIN_RUN.findall(orig) if 8 <= len(c) <= 48]
    return [c for c in chunks if c.lower() not in ko.lower()]


_CJK_LEAK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")


def find_cjk_leaks(text: str) -> list[str]:
    """한국어 문장에 섞인 한자·가나 덩어리. 한글은 제외한다."""
    return _CJK_LEAK.findall(text or "")


def article_body(item: dict) -> str:
    desc = str(item.get("description") or "").strip()
    content = str(item.get("content") or "").strip()
    if content.startswith("{") or content.startswith("["):
        return desc
    return content if len(content) > len(desc) else desc


def _clip(text: str, limit: int) -> str:
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "…"


def pick_translate_items(conn: Conn, *, hours: int, limit: int,
                         item_ids: list[int] | None = None,
                         min_chars: int = 80) -> list[dict]:
    """최근 기사 중 매체·언어가 겹치지 않게 고른다."""
    if item_ids:
        marks = ",".join("?" for _ in item_ids)
        rows = conn.execute(
            f"""
            SELECT ri.id, ri.title, ri.description, ri.content, s.name AS source_name, s.lang
              FROM raw_items ri JOIN sources s ON s.id = ri.source_id
             WHERE ri.id IN ({marks})
             ORDER BY ri.id DESC
            """,
            tuple(item_ids),
        ).fetchall()
        return [dict(r) for r in rows]

    since = iso_hours_ago(hours)
    recent = conn.execute(
        """
        SELECT ri.id, ri.title, ri.description, ri.content, s.name AS source_name, s.lang
          FROM raw_items ri JOIN sources s ON s.id = ri.source_id
         WHERE s.kind = 'article'
           AND ri.fetched_at >= ?
           AND length(trim(coalesce(ri.description,''))) >= ?
         ORDER BY ri.id DESC
         LIMIT ?
        """,
        (since, min_chars, max(limit * 8, 40)),
    ).fetchall()
    # 한 매체가 창을 채우면(4Gamer 등) 비교가 안 된다 → 소스별 최신 1건으로 보충
    latest = conn.execute(
        """
        SELECT ri.id, ri.title, ri.description, ri.content, s.name AS source_name, s.lang
          FROM raw_items ri JOIN sources s ON s.id = ri.source_id
         WHERE s.kind = 'article'
           AND length(trim(coalesce(ri.description,''))) >= ?
           AND ri.id = (
             SELECT MAX(x.id) FROM raw_items x WHERE x.source_id = ri.source_id
           )
         ORDER BY ri.id DESC
        """,
        (min_chars,),
    ).fetchall()
    pool, seen = [], set()
    for r in list(recent) + list(latest):
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        pool.append(r)
    picked, used_src = [], set()
    for r in pool:
        if r["source_name"] in used_src:
            continue
        picked.append(r)
        used_src.add(r["source_name"])
        if len(picked) >= limit:
            return [dict(x) for x in picked]
    have = {p["id"] for p in picked}
    for r in pool:
        if r["id"] in have:
            continue
        picked.append(r)
        if len(picked) >= limit:
            break
    return [dict(x) for x in picked]


def pick_write_stories(conn: Conn, *, limit: int,
                       story_ids: list[int] | None = None) -> list[int]:
    if story_ids:
        return story_ids
    rows = conn.execute(
        """
        SELECT id FROM stories
         WHERE status IN ('published','edited','drafted','clustered')
           AND source_count >= 1
         ORDER BY id DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [int(r["id"]) for r in rows]


def _cluster_from_hits(hits: list[Hit]) -> Cluster:
    seeds = [h.item for h in hits if h.role == "seed"]
    if not seeds:
        seeds = [h.item for h in hits if h.role != "community"]
    cvec = _centroid([h.item.vec for h in hits]) if hits else []
    cl = Cluster(seeds=seeds or [hits[0].item], centroid=cvec) if hits else Cluster(seeds=[], centroid=[])
    cl.retrieved = [h for h in hits if h.role == "retrieved"]
    cl.community = [h for h in hits if h.role == "community"]
    return cl


def _fill(template: str, **kwargs: str) -> str:
    out = template
    for k, v in kwargs.items():
        out = out.replace("{" + k + "}", v)
    return out


def _call(chat: OpenRouterChat, *, model: str, system: str, user: str,
          temperature: float, max_tokens: int) -> tuple[LLMResult | None, int, str | None]:
    t0 = time.monotonic()
    try:
        result = chat.complete(
            model=model, system=system, user=user,
            temperature=temperature, max_tokens=max_tokens, strict_json=False,
        )
        return result, int((time.monotonic() - t0) * 1000), None
    except Exception as exc:  # noqa: BLE001
        return None, int((time.monotonic() - t0) * 1000), f"{type(exc).__name__}: {exc}"


def _insert_output(conn: Conn, *, run_id: int, case_id: int, model: str,
                   result: LLMResult | None, latency_ms: int, error: str | None) -> None:
    title = body = raw = None
    prompt_tokens = completion_tokens = 0
    cost = None
    if result is not None:
        raw = result.text
        title = str(result.data.get("title_ko") or "").strip() or None
        body = str(result.data.get("body_md") or "").strip() or None
        prompt_tokens = result.prompt_tokens
        completion_tokens = result.completion_tokens
        cost = result.cost_usd
        if not title and not body and not error:
            error = "JSON 필드 없음 (title_ko/body_md)"
    conn.execute(
        """
        INSERT INTO bench_outputs
            (run_id, case_id, model, title_ko, body_md, raw_text, latency_ms,
             prompt_tokens, completion_tokens, cost_usd, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, case_id, model, title, body, raw, latency_ms,
         prompt_tokens, completion_tokens, cost, error, utcnow()),
    )


def _md_cell(text: str, limit: int = 120) -> str:
    t = (text or "").replace("|", "\\|").replace("\n", " ").strip()
    return _clip(t, limit) or "—"


def _raw_lede(raw_text: str | None) -> str:
    """write 벤치 출력엔 lede_ko 가 raw JSON 에만 있다. 리포트용으로 꺼낸다."""
    if not raw_text:
        return ""
    try:
        data = parse_json_object(raw_text)
    except Exception:  # noqa: BLE001
        return ""
    return str(data.get("lede_ko") or "").strip()


def _render_index(conn: Conn) -> str:
    rows = list_runs(conn, limit=50)
    lines = [
        "# writer bench 목록",
        "",
        "최신 결과는 [latest.md](latest.md).",
        "",
        "| id | task | n | 상태 | 파일 | 시작 |",
        "|---:|---|---:|---|---|---|",
    ]
    for r in rows:
        name = f"run-{r['id']}.md"
        path = r.get("report_path") or name
        link = Path(path).name if path else name
        lines.append(
            f"| {r['id']} | {r['task']} | {r['case_count']} | {r['status']} "
            f"| [{link}]({link}) | {r['started_at']} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_report_files(conn: Conn, run_id: int, dest_dir: Path) -> dict[str, Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    report = _render_report(conn, run_id)
    path = dest_dir / f"run-{run_id}.md"
    latest = dest_dir / "latest.md"
    index = dest_dir / "index.md"
    path.write_text(report, encoding="utf-8")
    latest.write_text(report, encoding="utf-8")
    index.write_text(_render_index(conn), encoding="utf-8")
    return {"report": path, "latest": latest, "index": index}


def latest_run_id(conn: Conn) -> int | None:
    row = conn.execute(
        "SELECT id FROM bench_runs WHERE status='ok' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return int(row["id"]) if row else None


def _render_report(conn: Conn, run_id: int) -> str:
    run = conn.execute("SELECT * FROM bench_runs WHERE id=?", (run_id,)).fetchone()
    cases = conn.execute(
        "SELECT * FROM bench_cases WHERE run_id=? ORDER BY id", (run_id,)
    ).fetchall()
    outputs = conn.execute(
        "SELECT * FROM bench_outputs WHERE run_id=? ORDER BY case_id, id", (run_id,)
    ).fetchall()
    by_case: dict[int, list] = {}
    for o in outputs:
        by_case.setdefault(o["case_id"], []).append(o)

    case_title = {c["id"]: c["title"] for c in cases}
    flags: dict[int, tuple[list[str], list[str]]] = {}
    for o in outputs:
        text = o["raw_text"] if o["error"] else f"{o['title_ko'] or ''}\n{o['body_md'] or ''}"
        leaks = find_cjk_leaks(text)
        miss = [] if o["error"] else missing_terms(o["title_ko"] or "", case_title.get(o["case_id"], ""))
        flags[o["id"]] = (leaks, miss)

    models = [m.strip() for m in (run["models"] or "").split(",") if m.strip()]
    lines = [
        f"# writer bench {run_id} — {run['task']}",
        "",
        f"- 시작: {run['started_at']}",
        f"- 모델: {', '.join(models)}",
        f"- 케이스: {run['case_count']}",
        f"- 상태: {run['status']}",
        "",
        "## 요약",
        "",
        "| 모델 | 성공 | 실패 | 평균 ms | 토큰(완료) | 비용 USD | 한자누출 | 원제누락 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for model in models:
        rows = [o for o in outputs if o["model"] == model]
        ok = sum(1 for o in rows if not o["error"])
        err = sum(1 for o in rows if o["error"])
        ms = [o["latency_ms"] for o in rows if o["latency_ms"] is not None]
        toks = sum(o["completion_tokens"] or 0 for o in rows)
        cost = sum(o["cost_usd"] or 0 for o in rows)
        avg = int(sum(ms) / len(ms)) if ms else 0
        leak_n = sum(1 for o in rows if flags[o["id"]][0])
        miss_n = sum(1 for o in rows if flags[o["id"]][1])
        lines.append(
            f"| `{model}` | {ok} | {err} | {avg} | {toks} | {cost:.4f} | {leak_n} | {miss_n} |"
        )
    lines += [
        "",
        "같은 원문을 보고 고른다. 자동 점수는 없다. 한자누출/원제누락은 건수(플래그 전용, 출력은 안 고친다).",
        "",
        "## 목차",
        "",
    ]
    for i, case in enumerate(cases, 1):
        src = case["source_name"] or ""
        lines.append(f"{i}. [{src}] {case['title'][:70]}")
    lines.append("")

    for i, case in enumerate(cases, 1):
        src = case["source_name"] or (f"story #{case['story_id']}" if case["story_id"] else "")
        rows = by_case.get(case["id"], [])
        lines += [
            f"## {i}. [{src}] {case['title'][:90]}",
            "",
            f"- lang: {case['lang'] or '-'}",
            f"- raw_item: {case['raw_item_id'] or '-'} / story: {case['story_id'] or '-'}",
            "",
            "### 원문",
            "",
            "```",
            _clip(case["input_text"], 1200),
            "```",
            "",
            "### 제목 비교",
            "",
            "| 모델 | 제목 | 플래그 |",
            "|---|---|---|",
        ]
        for o in rows:
            title = o["error"] or o["title_ko"] or "(없음)"
            leaks, miss = flags[o["id"]]
            tags = []
            if leaks:
                tags.append("한자 " + "".join(leaks))
            if miss:
                tags.append("원제누락 " + ", ".join(miss[:2]))
            tag = _md_cell(" / ".join(tags) or "—", 80)
            lines.append(f"| `{o['model']}` | {_md_cell(title, 160)} | {tag} |")
        lines.append("")
        for o in rows:
            lines.append(f"### `{o['model']}`  ({o['latency_ms'] or 0}ms)")
            lines.append("")
            leaks, miss = flags[o["id"]]
            if leaks:
                lines.append(f"> ⚠ 한자 누출: {' / '.join(leaks)}")
            if miss:
                lines.append(f"> ⚠ 원제 누락: {', '.join(miss)}")
            if leaks or miss:
                lines.append("")
            if o["error"]:
                lines.append(f"**에러:** {o['error']}")
                if o["raw_text"]:
                    lines += ["", "```", _clip(o["raw_text"], 800), "```"]
                lines.append("")
                continue
            if o["title_ko"]:
                lines.append(f"**제목:** {o['title_ko']}")
                lines.append("")
            lede = _raw_lede(o["raw_text"])
            if lede:
                lines.append(f"**요약:** {lede.replace(chr(10), ' / ')}")
                lines.append("")
            lines.append(o["body_md"] or o["raw_text"] or "(빈 본문)")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def run_bench(
    conn: Conn,
    settings: Settings,
    chat: OpenRouterChat,
    *,
    task: str = "translate",
    models: list[str] | None = None,
    limit: int = 6,
    hours: int = 48,
    item_ids: list[int] | None = None,
    story_ids: list[int] | None = None,
    out_dir: Path | None = None,
) -> dict:
    task = (task or "translate").strip().lower()
    if task not in ("translate", "write"):
        raise ValueError(f"task 는 translate | write: {task}")
    models = models or parse_models(settings.bench_models)
    prompts = load_prompts(settings.prompts_file)
    started = utcnow()
    cur = conn.execute(
        "INSERT INTO bench_runs (task, models, case_count, started_at, status) "
        "VALUES (?, ?, 0, ?, 'running')",
        (task, ",".join(models), started),
    )
    run_id = int(cur.lastrowid)

    try:
        if task == "translate":
            spec = prompts["bench_translate"]
            items = pick_translate_items(conn, hours=hours, limit=limit, item_ids=item_ids)
            if not items:
                raise RuntimeError("번역할 최근 기사가 없다. collector 를 먼저 돌려라")
            case_ids = []
            for it in items:
                body = article_body(it)
                input_text = f"{it['title']}\n\n{body}".strip()
                c = conn.execute(
                    """
                    INSERT INTO bench_cases
                        (run_id, raw_item_id, story_id, source_name, lang, title, input_text)
                    VALUES (?, ?, NULL, ?, ?, ?, ?)
                    """,
                    (run_id, it["id"], it["source_name"], it["lang"], it["title"], input_text),
                )
                case_ids.append((int(c.lastrowid), it, input_text))
            conn.execute("UPDATE bench_runs SET case_count=? WHERE id=?", (len(case_ids), run_id))
            for model in models:
                for case_id, it, _input in case_ids:
                    title = str(it["title"] or "")
                    body = article_body(it)
                    user = _fill(
                        spec["user"],
                        source=str(it["source_name"] or ""),
                        lang=str(it["lang"] or ""),
                        title=title,
                        keep=keep_terms(title, body),
                        text=_clip(body, 4000),
                    ).strip()
                    log.info("bench translate model=%s item=%s", model, it["id"])
                    result, ms, err = _call(
                        chat, model=model, system=spec["system"].strip(), user=user,
                        temperature=settings.temperature,
                        max_tokens=settings.max_tokens,
                    )
                    _insert_output(
                        conn, run_id=run_id, case_id=case_id, model=model,
                        result=result, latency_ms=ms, error=err,
                    )
        else:
            sids = pick_write_stories(conn, limit=limit, story_ids=story_ids)
            if not sids:
                raise RuntimeError("쓸 스토리가 없다. writer cluster 를 먼저 돌려라")
            case_ids = []
            packs: dict[int, str] = {}
            for sid in sids:
                hits = load_story_hits(conn, sid, settings.embed_model)
                if not hits:
                    log.warning("story %s 소스 없음 — 건너뜀", sid)
                    continue
                pack = build_pack(_cluster_from_hits(hits))
                title = hits[0].item.title
                c = conn.execute(
                    """
                    INSERT INTO bench_cases
                        (run_id, raw_item_id, story_id, source_name, lang, title, input_text)
                    VALUES (?, NULL, ?, ?, '', ?, ?)
                    """,
                    (run_id, sid, f"story #{sid}", title, pack),
                )
                cid = int(c.lastrowid)
                case_ids.append(cid)
                packs[cid] = pack
            conn.execute("UPDATE bench_runs SET case_count=? WHERE id=?", (len(case_ids), run_id))
            spec = prompts["writer"]
            for model in models:
                for case_id in case_ids:
                    log.info("bench write model=%s case=%s", model, case_id)
                    user = _fill(spec["user"], pack=packs[case_id]).strip()
                    result, ms, err = _call(
                        chat, model=model, system=spec["system"].strip(), user=user,
                        temperature=settings.temperature,
                        max_tokens=settings.max_tokens,
                    )
                    _insert_output(
                        conn, run_id=run_id, case_id=case_id, model=model,
                        result=result, latency_ms=ms, error=err,
                    )

        dest_dir = Path(out_dir or settings.out_dir) / "bench"
        dest_dir.mkdir(parents=True, exist_ok=True)
        path = dest_dir / f"run-{run_id}.md"
        conn.execute(
            "UPDATE bench_runs SET finished_at=?, status='ok', report_path=? WHERE id=?",
            (utcnow(), str(path), run_id),
        )
        files = write_report_files(conn, run_id, dest_dir)
        return {
            "run_id": run_id, "task": task, "models": models,
            "cases": conn.execute("SELECT case_count FROM bench_runs WHERE id=?", (run_id,)).fetchone()["case_count"],
            "report": str(files["report"]),
            "latest": str(files["latest"]),
            "index": str(files["index"]),
        }
    except Exception as exc:  # noqa: BLE001
        conn.execute(
            "UPDATE bench_runs SET finished_at=?, status='error', error=? WHERE id=?",
            (utcnow(), str(exc)[:500], run_id),
        )
        raise


def list_runs(conn: Conn, *, limit: int = 20) -> list[dict]:
    rows = conn.execute(
        "SELECT id, task, models, case_count, status, started_at, report_path "
        "FROM bench_runs ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def show_run(conn: Conn, run_id: int | None = None) -> str:
    if run_id is None:
        run_id = latest_run_id(conn)
        if run_id is None:
            raise RuntimeError("벤치 런이 없다. writer bench run")
    row = conn.execute("SELECT report_path FROM bench_runs WHERE id=?", (run_id,)).fetchone()
    if row is None:
        raise RuntimeError(f"bench run 없음: {run_id}")
    path = Path(row["report_path"] or "")
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return _render_report(conn, run_id)
