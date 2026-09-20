"""writer CLI — 묶기 + RAG + OpenRouter 한글 기사.

    writer init-db
    writer doctor
    writer cluster [--limit N] [--dry-run]
    writer write --story-id N
    writer stories [--limit N]
    writer run [--interval 10800] [--once] [--limit N] [--dry-run] [--no-write]
    writer bench                 .env BENCH_MODELS 로 경합 (show|run 생략 가능)
    writer batch                 bench 별칭
    writer bench show [--run-id N] [--open] [--list]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time

from . import __version__
from .db import collector_counts, connect, counts, embed_models, init_db
from .llm import OpenRouterChat
from .bench import latest_run_id, list_runs, parse_models, run_bench, show_run
from .pipeline import build_prepared, format_plan, persist_prepared, run_once, write_story
from .settings import load_settings
from .agents import load_prompts, prompt_version
from .store import advance_intake, load_story

log = logging.getLogger("writer")
_STOP = False
_SIG_COUNT = 0


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S", stream=sys.stderr,
    )


def _sig(signum, _frame) -> None:
    global _STOP, _SIG_COUNT
    _SIG_COUNT += 1
    _STOP = True
    if _SIG_COUNT >= 2:
        log.error("강제 종료")
        os._exit(130)
    log.info("종료 신호 — 이번 편 마치고 종료. 바로 끄려면 Ctrl-C 한 번 더")


def _open(settings):
    conn = connect(settings.db_path)
    init_db(conn, settings.schema_file)
    return conn


def _chat(settings, **kw) -> OpenRouterChat:
    opts = {
        "timeout": settings.timeout,
        "min_interval": settings.min_interval,
        "reasoning_effort": settings.reasoning_effort,
    }
    opts.update(kw)
    return OpenRouterChat(settings.openrouter_base, settings.openrouter_api_key, **opts)


def cmd_init_db(args) -> int:
    s = load_settings()
    conn = _open(s)
    print(f"스키마 적용: {s.db_path}")
    print(json.dumps(counts(conn), indent=2, ensure_ascii=False))
    return 0


def cmd_doctor(args) -> int:
    s = load_settings()
    print(f"DB         : {s.db_path}")
    print(f"prompts    : {s.prompts_file}")
    print(f"out        : {s.out_dir}")
    print(f"embed_model: {s.embed_model}")
    print(f"writer     : {s.writer_model} (단일 호출)")
    print(f"bench      : {s.bench_models}")
    print(f"api_key    : {'set' if s.openrouter_api_key else 'MISSING'}")
    if not s.db_path.exists():
        print("DB FAIL    : 파일이 없다. collector 를 먼저 돌려라")
        return 1
    conn = _open(s)
    cc = collector_counts(conn)
    print(f"collector  : {cc}")
    if any(v < 0 for v in cc.values()):
        print("DB FAIL    : collector 테이블이 없다")
        return 1
    print(f"writer     : {counts(conn)}")
    models = embed_models(conn)
    print(f"벡터 모델  : {models}")
    names = [m for m, _ in models]
    if s.embed_model not in names:
        print(f"경고       : EMBED_MODEL={s.embed_model} 이 DB 에 없다. 센트로이드 RAG 가 비게 된다")
    return 0


def cmd_cluster(args) -> int:
    s = load_settings()
    conn = _open(s)
    candidates, prepared = build_prepared(conn, s, limit=args.limit)
    print(format_plan(prepared))
    print(f"후보 {len(candidates)}건 → 클러스터 {len(prepared)} "
          f"(write={sum(1 for p in prepared if p.decision == 'write')} "
          f"skip={sum(1 for p in prepared if p.decision == 'skip')} "
          f"merge={sum(1 for p in prepared if p.decision == 'merge')})")
    if args.dry_run:
        return 0
    stats = persist_prepared(conn, s, prepared, run_id=None)
    mark = advance_intake(conn, [c.id for c in candidates])
    stats["intake_after_id"] = mark
    print(f"저장: {json.dumps(stats, ensure_ascii=False)}")
    return 0


def cmd_write(args) -> int:
    s = load_settings()
    conn = _open(s)
    st = load_story(conn, args.story_id)
    if st is None:
        print(f"story 없음: {args.story_id}", file=sys.stderr)
        return 2
    chat = _chat(s)
    try:
        path = write_story(
            conn, s, chat, story_id=args.story_id, run_id=None,
            prompts=load_prompts(s.prompts_file), pver=prompt_version(s.prompts_file),
        )
    finally:
        chat.close()
    print(f"발행: {path}")
    return 0


def cmd_stories(args) -> int:
    s = load_settings()
    conn = _open(s)
    rows = conn.execute(
        """
        SELECT id, status, source_count, community_count, importance, slug, title_ko, skip_reason, updated_at
          FROM stories ORDER BY id DESC LIMIT ?
        """,
        (args.limit,),
    )
    print(f"{'id':>4} {'st':<10} {'src':>3} {'c':>2} {'imp':>5} slug / title")
    n = 0
    for r in rows:
        title = r["title_ko"] or r["skip_reason"] or r["slug"] or ""
        print(f"{r['id']:>4} {r['status']:<10} {r['source_count']:>3} {r['community_count']:>2} "
              f"{r['importance']:>5.1f} {title[:70]}")
        n += 1
    print(f"총 {n}개")
    return 0


def cmd_bench(args) -> int:
    if getattr(args, "bench_cmd", None) == "show":
        return cmd_bench_show(args)
    return cmd_bench_run(args)


def cmd_bench_run(args) -> int:
    s = load_settings()
    conn = _open(s)
    models = parse_models(args.models, s.bench_models)
    chat = _chat(s, reasoning_effort="none", exclude_reasoning=True)
    try:
        stats = run_bench(
            conn, s, chat,
            task=args.task,
            models=models,
            limit=args.limit if args.limit is not None else 6,
            hours=args.hours,
            item_ids=args.item_id,
            story_ids=args.story_id,
        )
    finally:
        chat.close()
    print(f"run_id   {stats['run_id']}")
    print(f"마크다운  {stats['report']}")
    print(f"최신본    {stats['latest']}")
    print(f"목록      {stats['index']}")
    print("보기      uv run writer bench show")
    if args.open:
        _open_file(stats["latest"])
    return 0


def _open_file(path: str) -> None:
    import shutil
    import subprocess
    opener = shutil.which("open") or shutil.which("xdg-open")
    if opener is None:
        print(f"열 프로그램이 없다. 파일을 직접 연다: {path}", file=sys.stderr)
        return
    subprocess.Popen([opener, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cmd_bench_show(args) -> int:
    s = load_settings()
    conn = _open(s)
    if args.list:
        rows = list_runs(conn, limit=args.limit if args.limit is not None else 20)
        if not rows:
            print("벤치 런이 없다. writer bench run")
            return 0
        print(f"{'id':>4} {'task':<10} {'n':>3} {'st':<8} 파일")
        for r in rows:
            print(f"{r['id']:>4} {r['task']:<10} {r['case_count']:>3} {r['status']:<8} "
                  f"{r['report_path'] or '-'}")
        return 0
    try:
        text = show_run(conn, args.run_id)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 2
    rid = args.run_id or latest_run_id(conn)
    row = conn.execute("SELECT report_path FROM bench_runs WHERE id=?", (rid,)).fetchone() if rid else None
    path = row["report_path"] if row else ""
    if path:
        print(f"파일: {path}", file=sys.stderr)
    print(text, end="" if text.endswith("\n") else "\n")
    if args.open and path:
        _open_file(path)
    return 0


def cmd_run(args) -> int:
    s = load_settings()
    conn = _open(s)
    interval = args.interval or s.interval
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    log.info("writer 시작 (주기 %d초, DB %s, dry_run=%s, write=%s)",
             interval, s.db_path, args.dry_run, not args.no_write)

    chat = None
    if not args.dry_run and not args.no_write:
        try:
            chat = _chat(s)
        except Exception as exc:  # noqa: BLE001
            log.error("OpenRouter 준비 실패: %s", exc)
            return 1

    try:
        while not _STOP:
            t0 = time.time()
            try:
                stats = run_once(
                    conn, s, limit=args.limit, dry_run=args.dry_run,
                    write=not args.no_write and not args.dry_run, chat=chat,
                    should_stop=lambda: _STOP,
                )
                if args.dry_run:
                    print(stats["plan"])
                    print(json.dumps({k: v for k, v in stats.items() if k != "plan"},
                                     ensure_ascii=False, indent=2))
                else:
                    log.info("주기 완료: %s", {k: v for k, v in stats.items() if k != "plan"})
            except Exception as exc:  # noqa: BLE001
                log.exception("주기 작업 실패(다음 주기에 재시도): %s", exc)
            if args.once:
                break
            wait = max(5.0, interval - (time.time() - t0))
            log.info("다음 주기까지 %.0f초 대기 (끝내려면 Ctrl-C, 한 번만이면 --once)", wait)
            deadline = time.time() + wait
            while not _STOP and time.time() < deadline:
                time.sleep(min(2.0, deadline - time.time()))
    finally:
        if chat is not None:
            chat.close()
    log.info("writer 종료")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="writer", description="수집본 RAG → 한글 기사 (OpenRouter)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--version", action="version", version=f"writer {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db").set_defaults(func=cmd_init_db)
    sub.add_parser("doctor", help="점검").set_defaults(func=cmd_doctor)

    c = sub.add_parser("cluster", help="묶기+RAG+선별 (LLM 없음)")
    c.add_argument("--limit", type=int, help="섭취 배치 크기 (기본 WRITER_BATCH=100)")
    c.add_argument("--dry-run", action="store_true")
    c.set_defaults(func=cmd_cluster)

    w = sub.add_parser("write", help="스토리 하나 쓰기")
    w.add_argument("--story-id", type=int, required=True)
    w.set_defaults(func=cmd_write)

    ls = sub.add_parser("stories", help="최근 스토리")
    ls.add_argument("--limit", type=int, default=30)
    ls.set_defaults(func=cmd_stories)

    rn = sub.add_parser("run", help="묶기 후 글쓰기 반복")
    rn.add_argument("--interval", type=int)
    rn.add_argument("--once", action="store_true")
    rn.add_argument("--limit", type=int, help="섭취 배치 크기")
    rn.add_argument("--dry-run", action="store_true")
    rn.add_argument("--no-write", action="store_true", help="묶기만 하고 LLM 을 안 친다")
    rn.set_defaults(func=cmd_run)

    def _bench_run_flags(p) -> None:
        p.add_argument("--task", choices=("translate", "write"), default="translate",
                       help="translate=최근 RSS 번역, write=기존 스토리 팩으로 단신")
        p.add_argument("--models", help="없으면 .env BENCH_MODELS")
        p.add_argument("--limit", type=int, default=None,
                       help="run: 케이스 수 (기본 6). show --list: 런 수 (기본 20)")
        p.add_argument("--hours", type=int, default=48)
        p.add_argument("--item-id", type=int, action="append", help="번역할 raw_item id. 반복 가능")
        p.add_argument("--story-id", type=int, action="append", help="write 태스크 스토리 id")
        p.add_argument("--open", action="store_true", help="저장된 마크다운을 연다")
        p.add_argument("--run-id", type=int)
        p.add_argument("--list", action="store_true", help="show 일 때 런 목록만")

    b = sub.add_parser("bench", help="모델 경합. 인자 없이 실행하면 BENCH_MODELS 로 돈다")
    b.add_argument("bench_cmd", nargs="?", default="run", choices=("run", "show"),
                   help="생략하면 run")
    _bench_run_flags(b)
    b.set_defaults(func=cmd_bench)

    batch = sub.add_parser("batch", help="bench 별칭. uv run writer batch")
    _bench_run_flags(batch)
    batch.set_defaults(func=cmd_bench_run, bench_cmd="run")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _setup_logging(args.verbose)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
