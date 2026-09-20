"""collector CLI — 수집 + 관리만. (writer 는 별도)

    collector init-db                 스키마 생성
    collector sources sync|list       피드 등록/조회
    collector collect [--source REF] [--force]
    collector noise                   노이즈 1차 필터 (규칙)
    collector embed [--limit N] [--rebuild] [--purge]   임베딩 (로컬 기본, OpenRouter 선택)
    collector report [--hours 24]     검증 리포트
    collector run [--interval 900]    수집 → 필터 → 임베딩 반복 (상시 실행)
    collector doctor                  임베딩 서버 점검
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import time
from pathlib import Path

from . import __version__
from .collector import collect_all
from .db import connect, counts, init_db
from .reddit import RedditGate
from .embed import embed_pending, make_embedder, purge_other_models, reset_for_reembed
from .noise import NoiseRules, apply_rules
from .report import build_report
from .settings import load_settings
from .sources import list_sources, resolve_source, sync_sources

log = logging.getLogger("collector")
_STOP = False


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S", stream=sys.stderr,
    )


def _sig(signum, _frame) -> None:
    global _STOP
    _STOP = True
    log.info("종료 신호(%s) — 현재 작업 마치고 종료", signum)


def _open(settings):
    conn = connect(settings.db_path)
    init_db(conn, settings.schema_file)
    return conn


# ---------------------------------------------------------------- commands
def cmd_init_db(args) -> int:
    s = load_settings()
    conn = _open(s)
    print(f"스키마 적용: {s.db_path}")
    print(json.dumps(counts(conn), indent=2))
    return 0


def cmd_sources_sync(args) -> int:
    s = load_settings()
    conn = _open(s)
    print(f"sources sync: {sync_sources(conn, s.sources_file)}")
    return 0


def cmd_sources_list(args) -> int:
    s = load_settings()
    conn = _open(s)
    rows = list_sources(conn, enabled_only=args.enabled)
    print(f"{'id':>3} {'en':>2} {'w':>4} {'kind':<9} {'lang':<4} {'ua':<3} {'fp':<3} name / last_fetch")
    for r in rows:
        print(f"{r['id']:>3} {r['enabled']:>2} {r['weight']:>4.1f} {r['kind']:<9} {r['lang']:<4} "
              f"{'Y' if r['user_agent'] else '-':<3} {'Y' if r['impersonate'] else '-':<3} "
              f"{r['name']} / {r['last_fetched_at'] or '-'}")
    print(f"총 {len(rows)}개")
    return 0


def cmd_collect(args) -> int:
    s = load_settings()
    conn = _open(s)
    only_id = None
    if args.source:
        row = resolve_source(conn, args.source)
        if row is None:
            print(f"source 없음: {args.source}", file=sys.stderr)
            return 2
        only_id = row["id"]
    results = collect_all(
        conn,
        timeout=args.timeout or s.fetch_timeout,
        user_agent=s.user_agent,
        only_source_id=only_id,
        reddit_comment_posts=s.reddit_comment_posts,
        reddit_sleep=s.reddit_sleep,
        reddit_min_interval=0 if args.force else s.reddit_min_interval,
        reddit_user=s.reddit_user,
        reddit_feed=s.reddit_feed,
    )
    failed = [r for r in results if not r.ok]
    print(f"수집: feeds={len(results)} ok={len(results) - len(failed)} failed={len(failed)} "
          f"new={sum(r.new_items for r in results)} dup={sum(r.duplicate for r in results)} "
          f"댓글={sum(r.comments_saved for r in results)}")
    for r in failed:
        print(f"  ! {r.name}: {r.error}", file=sys.stderr)
    return 0 if not failed else 1


def cmd_noise(args) -> int:
    s = load_settings()
    conn = _open(s)
    rules = NoiseRules.load(s.noise_rules_file)
    print(f"noise: {json.dumps(apply_rules(conn, rules), ensure_ascii=False)}")
    return 0


def cmd_embed(args) -> int:
    s = load_settings()
    conn = _open(s)
    if args.rebuild:
        n = reset_for_reembed(conn, s.embed_model)
        conn.commit()
        print(f"rebuild: {n}건을 다시 큐에 넣음 (model={s.embed_model})")
    embedder = make_embedder(s)
    try:
        stats = embed_pending(conn, embedder, batch=s.embed_batch,
                              max_chars=s.embed_max_chars, limit=args.limit)
    finally:
        embedder.close()
    print(f"embed: {json.dumps(stats, ensure_ascii=False)}")
    if args.purge:
        n = purge_other_models(conn, s.embed_model)
        conn.commit()
        print(f"purge: 다른 모델 벡터 {n}건 삭제")
    return 0


def cmd_report(args) -> int:
    s = load_settings()
    conn = _open(s)
    text = build_report(conn, s.embed_model, hours=args.hours, sim_sample=args.sim_sample,
                        threshold=s.sim_threshold)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"리포트 저장: {args.out}")
    else:
        print(text)
    return 0


def cmd_run(args) -> int:
    s = load_settings()
    conn = _open(s)
    interval = args.interval or s.collect_interval
    rules = NoiseRules.load(s.noise_rules_file)
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    log.info("collector 시작 (주기 %d초, DB %s)", interval, s.db_path)
    reddit_gap = s.reddit_sleep if (s.reddit_user and s.reddit_feed) else max(s.reddit_sleep, 60.0)
    reddit_gate = RedditGate(min_interval=reddit_gap)

    # 모델 로드는 비싸므로 루프 밖에서 한 번만. 실패해도 수집/필터는 계속 돌린다.
    embedder = None
    try:
        embedder = make_embedder(s)
        log.info("임베딩 백엔드: %s", embedder.info())
    except Exception as exc:  # noqa: BLE001
        log.error("임베딩 백엔드 준비 실패 — 수집/필터만 돌린다: %s", exc)

    try:
        while not _STOP:
            t0 = time.time()
            try:
                results = collect_all(
                    conn, timeout=s.fetch_timeout, user_agent=s.user_agent,
                    reddit_comment_posts=s.reddit_comment_posts, reddit_sleep=s.reddit_sleep,
                    reddit_min_interval=s.reddit_min_interval,
                    reddit_user=s.reddit_user, reddit_feed=s.reddit_feed,
                    reddit_gate=reddit_gate,
                )
                log.info("수집 완료: feeds=%d new=%d dup=%d 댓글=%d",
                         len(results), sum(r.new_items for r in results),
                         sum(r.duplicate for r in results), sum(r.comments_saved for r in results))
                apply_rules(conn, rules)
                if embedder is not None:
                    embed_pending(conn, embedder, batch=s.embed_batch,
                                  max_chars=s.embed_max_chars)
            except Exception as exc:  # noqa: BLE001
                log.exception("주기 작업 실패(다음 주기에 재시도): %s", exc)

            if args.once:
                break
            wait = max(5.0, interval - (time.time() - t0))
            log.info("다음 주기까지 %.0f초 대기", wait)
            deadline = time.time() + wait
            while not _STOP and time.time() < deadline:
                time.sleep(min(2.0, deadline - time.time()))
    finally:
        if embedder is not None:
            embedder.close()
    log.info("collector 종료")
    return 0


def cmd_doctor(args) -> int:
    s = load_settings()
    print(f"DB        : {s.db_path}")
    print(f"sources   : {s.sources_file}")
    print(f"noise     : {s.noise_rules_file}")
    print(f"임베딩     : provider={s.embed_provider} model={s.embed_model} prompt={s.embed_prompt}")
    reddit_auth = "yes" if (s.reddit_user and s.reddit_feed) else "NO (익명 RSS 는 429)"
    print(f"Reddit    : auth={reddit_auth} user={s.reddit_user or '-'} comments={s.reddit_comment_posts}")
    conn = _open(s)
    print(f"DB OK     : {counts(conn)}")
    try:
        embedder = make_embedder(s)
    except Exception as exc:  # noqa: BLE001
        print(f"임베딩 FAIL: {exc}")
        return 0
    try:
        print(f"백엔드 OK  : {embedder.info()}")
        v = embedder.embed(["테스트 문장"])
        print(f"임베딩 OK  : dim={len(v[0])}")
    except Exception as exc:  # noqa: BLE001
        print(f"임베딩 FAIL: {exc}")
    finally:
        embedder.close()
    return 0


# ---------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="collector", description="RSS/Reddit 수집 + 관리 (LLM 없음)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--version", action="version", version=f"collector {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db").set_defaults(func=cmd_init_db)

    sp = sub.add_parser("sources")
    ssub = sp.add_subparsers(dest="subcommand", required=True)
    ssub.add_parser("sync").set_defaults(func=cmd_sources_sync)
    ls = ssub.add_parser("list")
    ls.add_argument("--enabled", action="store_true")
    ls.set_defaults(func=cmd_sources_list)

    c = sub.add_parser("collect")
    c.add_argument("--source", help="이름 또는 id")
    c.add_argument("--timeout", type=float)
    c.add_argument("--force", action="store_true", help="Reddit 간격 무시")
    c.set_defaults(func=cmd_collect)

    sub.add_parser("noise", help="노이즈 1차 필터").set_defaults(func=cmd_noise)

    e = sub.add_parser("embed", help="임베딩 (로컬 내장 기본)")
    e.add_argument("--limit", type=int)
    e.add_argument("--rebuild", action="store_true",
                   help="다른 모델로 임베딩된 항목을 다시 큐에 넣는다(모델 교체 시)")
    e.add_argument("--purge", action="store_true", help="다른 모델 벡터 삭제")
    e.set_defaults(func=cmd_embed)

    r = sub.add_parser("report", help="검증 리포트")
    r.add_argument("--hours", type=int, default=24)
    r.add_argument("--sim-sample", type=int, default=300)
    r.add_argument("--out", help="파일로 저장")
    r.set_defaults(func=cmd_report)

    rn = sub.add_parser("run", help="수집→필터→임베딩 반복")
    rn.add_argument("--interval", type=int)
    rn.add_argument("--once", action="store_true")
    rn.set_defaults(func=cmd_run)

    sub.add_parser("doctor", help="점검").set_defaults(func=cmd_doctor)
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
