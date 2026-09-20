"""수집기 본체.

역할: 인터넷에서 새 자료를 가져와 raw_items 에 안전하게 넣는다.
      LLM 을 절대 호출하지 않는다. 임베딩은 embed.py 가 따로 한다.

처리: feed fetch → parse → URL 정규화 → 중복 제거 → raw_items(status='new')
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import feedparser
import httpx

from .db import utcnow
from .fetcher import FeedFetcher
from .reddit import GatedFetcher, RateLimitError, RedditGate, is_reddit_url, rss_first
from .settings import DEFAULT_USER_AGENT
from .textutil import strip_html
from .urlnorm import canonicalize, content_hash, url_hash

log = logging.getLogger(__name__)

DESC_LIMIT = 4000   # description 에 저장하는 최대 길이


def _entry_text(entry) -> str:
    """RSS 가 주는 텍스트 중 가장 쓸모 있는 것.

    피드마다 달랐다(실측): IGN/PC Gamer 는 content:encoded 에 본문을 넣고 summary 는
    한 줄 teaser 만 준다. Gematsu 는 비슷하고, Automaton/4Gamer 는 summary 뿐이다.
    → 둘 중 긴 쪽을 쓴다. 본문 페이지를 따로 받지 않는 선에서 최선이다.
    """
    summary = strip_html(entry.get("summary") or entry.get("description"), limit=DESC_LIMIT)
    blocks = entry.get("content") or []
    body = strip_html(blocks[0].get("value"), limit=DESC_LIMIT) if blocks else ""
    return body if len(body) > len(summary) else summary


@dataclass
class FeedResult:
    source_id: int
    name: str
    http_status: int | None = None
    entries: int = 0
    new_items: int = 0
    duplicate: int = 0
    skipped: int = 0
    not_modified: bool = False
    comments_saved: int = 0
    rate_limited: bool = False
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


def _entry_published(entry) -> str | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        st = entry.get(key)
        if st:
            try:
                return datetime(*st[:6], tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            except (TypeError, ValueError):
                continue
    return None


def _entry_link(entry, feed_url: str) -> str:
    link = (entry.get("link") or "").strip()
    if link:
        return link
    for l in entry.get("links") or []:
        href = (l.get("href") or "").strip()
        if href:
            return href
    guid = (entry.get("id") or "").strip()
    if guid.startswith("http"):
        return guid
    return f"{feed_url}#{guid}" if guid else ""


def fetch_reddit_comments(conn, client, raw_item_id: int, *, headers: dict, timeout: float, limit: int = 20) -> int:
    """Reddit 글의 댓글을 .rss 로 받아 raw_items.content 에 JSON 으로 저장.

    Reddit 은 게시글 피드와 달리 댓글도 .rss 로 준다(API 키 불필요).
      https://www.reddit.com/r/<sub>/comments/<id>/.rss?sort=top
    """
    row = conn.execute("SELECT url FROM raw_items WHERE id = ?", (raw_item_id,)).fetchone()
    if row is None or "/comments/" not in row["url"]:
        return 0
    url = row["url"].split("?")[0].rstrip("/") + f"/.rss?sort=top&limit={int(limit)}"
    resp = client.get(url, headers=headers, timeout=timeout)
    if getattr(resp, "status_code", 0) == 429:
        raise RateLimitError("HTTP 429")
    resp.raise_for_status()
    parsed = feedparser.parse(resp.content)

    post_title, comments = "", []
    for entry in parsed.entries:
        title = strip_html(entry.get("title"), limit=300)
        if not post_title:
            post_title = title
            continue
        author = ""
        m = re.match(r"^/u/([^ ]+) on ", title)
        if m:
            author, title = m.group(1), title[m.end():]
        comments.append(
            {
                "author": author,
                "text": strip_html(entry.get("summary") or entry.get("description"), limit=1000),
                "published_at": _entry_published(entry),
                "url": (entry.get("link") or "").strip(),
            }
        )
    payload = {"post_title": post_title, "comments": comments}
    blob = json.dumps(payload, ensure_ascii=False)
    conn.execute(
        "UPDATE raw_items SET content = ?, content_hash = ? WHERE id = ?",
        (blob, content_hash(blob), raw_item_id),
    )
    return len(comments)


def fetch_source(
    conn,
    source,
    *,
    client,
    timeout: float,
    comment_posts: int = 0,
    comment_sleep: float = 0.0,
) -> FeedResult:
    result = FeedResult(source_id=source["id"], name=source["name"])
    started_at = utcnow()

    headers = {}
    if source["user_agent"]:
        headers["User-Agent"] = source["user_agent"]
    if source["etag"]:
        headers["If-None-Match"] = source["etag"]
    if source["last_modified"]:
        headers["If-Modified-Since"] = source["last_modified"]

    try:
        resp = client.get(source["feed_url"], headers=headers, timeout=timeout)
        result.http_status = resp.status_code
        if resp.status_code == 429:
            raise RateLimitError("HTTP 429")
        if resp.status_code == 304:
            result.not_modified = True
            conn.execute(
                "UPDATE sources SET last_fetched_at=?, last_status=?, last_error=NULL WHERE id=?",
                (utcnow(), "304", source["id"]),
            )
            _log_fetch(conn, result, started_at)
            return result
        resp.raise_for_status()
        body = resp.content
    except RateLimitError as exc:
        result.rate_limited = True
        result.http_status = result.http_status or 429
        result.error = f"RateLimitError: {exc}"
        conn.execute(
            "UPDATE sources SET last_fetched_at=?, last_status=?, last_error=? WHERE id=?",
            (utcnow(), "429", result.error[:500], source["id"]),
        )
        _log_fetch(conn, result, started_at)
        log.warning("collector: %s 레이트리밋 - %s", source["name"], result.error)
        return result
    except Exception as exc:  # noqa: BLE001
        result.error = f"{type(exc).__name__}: {exc}"
        conn.execute(
            "UPDATE sources SET last_fetched_at=?, last_status=?, last_error=? WHERE id=?",
            (utcnow(), "error", result.error[:500], source["id"]),
        )
        _log_fetch(conn, result, started_at)
        log.warning("collector: %s 실패 - %s", source["name"], result.error)
        return result

    parsed = feedparser.parse(body)
    if getattr(parsed, "bozo", 0) and not parsed.entries:
        result.error = f"feed parse error: {getattr(parsed, 'bozo_exception', 'unknown')}"
        conn.execute(
            "UPDATE sources SET last_fetched_at=?, last_status=?, last_error=? WHERE id=?",
            (utcnow(), "error", result.error[:500], source["id"]),
        )
        _log_fetch(conn, result, started_at)
        return result

    result.entries = len(parsed.entries)
    now = utcnow()
    new_ids: list[int] = []

    for entry in parsed.entries:
        url = _entry_link(entry, source["feed_url"])
        if not url:
            result.skipped += 1
            continue
        title = strip_html(entry.get("title"), limit=500) or "(no title)"
        description = _entry_text(entry)
        # 같은 소스에 같은 제목이 이미 있으면 새 항목으로 보지 않는다.
        # URL 로만 막으면 안 된다: Steam News 는 'Team Fortress 2 Update Released' 같은
        # 제목을 새 URL 로 계속 발행한다(실측).
        if conn.execute("SELECT 1 FROM raw_items WHERE source_id = ? AND title = ? LIMIT 1",
                        (source["id"], title)).fetchone():
            result.duplicate += 1
            continue
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO raw_items
                (source_id, url, canonical_url, url_hash, title, description,
                 published_at, fetched_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
            """,
            (source["id"], url, canonicalize(url), url_hash(url), title, description,
             _entry_published(entry), now),
        )
        if cur.rowcount == 1:
            result.new_items += 1
            new_ids.append(int(cur.lastrowid))
        else:
            result.duplicate += 1

    if comment_posts > 0:
        targets = list(new_ids)
        seen = set(targets)
        for row in conn.execute(
            """
            SELECT id FROM raw_items
             WHERE source_id = ? AND instr(url, '/comments/') > 0
               AND (content IS NULL OR content = '')
             ORDER BY id DESC
            """,
            (source["id"],),
        ):
            if row["id"] not in seen:
                targets.append(int(row["id"]))
            if len(targets) >= comment_posts:
                break
        for rid in targets[:comment_posts]:
            if comment_sleep:
                time.sleep(comment_sleep)
            try:
                n = fetch_reddit_comments(conn, client, rid, headers=headers, timeout=timeout)
                result.comments_saved += n
                log.info("  └ 댓글 %d개 저장 (raw_item #%s)", n, rid)
            except RateLimitError as exc:
                result.rate_limited = True
                log.warning("  └ 댓글 레이트리밋(raw_item #%s): %s — 나머지 댓글 중단", rid, exc)
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("  └ 댓글 수집 실패(raw_item #%s): %s", rid, exc)

    conn.execute(
        """
        UPDATE sources SET last_fetched_at=?, last_status=?, last_error=NULL,
                           etag=?, last_modified=? WHERE id=?
        """,
        (utcnow(), str(result.http_status), resp.headers.get("ETag"),
         resp.headers.get("Last-Modified"), source["id"]),
    )
    _log_fetch(conn, result, started_at)
    log.info(
        "collector: %-24s http=%s entries=%d new=%d dup=%d 댓글=%d",
        source["name"], result.http_status, result.entries,
        result.new_items, result.duplicate, result.comments_saved,
    )
    return result


def _log_fetch(conn, result: FeedResult, started_at: str) -> None:
    conn.execute(
        """
        INSERT INTO source_fetches
            (source_id, started_at, finished_at, http_status, entries,
             new_items, duplicate, not_modified, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (result.source_id, started_at, utcnow(), result.http_status, result.entries,
         result.new_items, result.duplicate, 1 if result.not_modified else 0, result.error),
    )


def reddit_due(source, min_interval: int) -> bool:
    """Reddit 은 익명 레이트리밋이 빡빡해 매 주기 돌리면 429 만 쌓인다."""
    if min_interval <= 0:
        return True
    last = source["last_fetched_at"]
    if not last:
        return True
    try:
        ts = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except ValueError:
        return True
    return (datetime.now(timezone.utc) - ts).total_seconds() >= min_interval


def collect_all(
    conn,
    *,
    timeout: float = 20.0,
    user_agent: str = DEFAULT_USER_AGENT,
    only_source_id: int | None = None,
    sleep_between: float = 0.5,
    reddit_comment_posts: int = 0,
    reddit_sleep: float = 20.0,
    reddit_min_interval: int = 0,
    reddit_user: str = "",
    reddit_feed: str = "",
    reddit_gate: RedditGate | None = None,
) -> list[FeedResult]:
    sql = "SELECT * FROM sources WHERE enabled = 1"
    params: tuple = ()
    if only_source_id is not None:
        sql = "SELECT * FROM sources WHERE id = ?"
        params = (only_source_id,)
    sql += " ORDER BY weight DESC, id"

    sources = rss_first(conn.execute(sql, params).fetchall())
    results: list[FeedResult] = []
    headers = {
        "User-Agent": user_agent,
        "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml, */*",
    }
    if reddit_gate is None:
        interval = reddit_sleep if (reddit_user and reddit_feed) else max(reddit_sleep, 60.0)
        reddit_gate = RedditGate(min_interval=interval)
    gate = reddit_gate
    if any(is_reddit_url(s["feed_url"]) for s in sources) and not (reddit_user and reddit_feed):
        log.warning("REDDIT_USER/REDDIT_FEED 없음 — 익명 RSS 는 1 req/min 으로 막힌다. prefs/feeds 값을 .env 에 넣는다.")

    with httpx.Client(follow_redirects=True, headers=headers, timeout=timeout) as client:
        reddit_blocked = False
        for source in sources:
            reddit = is_reddit_url(source["feed_url"])
            if reddit and (reddit_blocked or gate.blocked):
                log.info("collector: %-24s 건너뜀 (Reddit 서킷브레이커)", source["name"])
                continue
            if reddit and not reddit_due(source, reddit_min_interval):
                log.info("collector: %-24s 건너뜀 (Reddit %d초 간격)", source["name"], reddit_min_interval)
                continue
            inner = FeedFetcher(client, impersonate=source["impersonate"])
            fetcher = GatedFetcher(inner, gate, reddit_user, reddit_feed) if reddit else inner
            result = fetch_source(
                conn, source, client=fetcher, timeout=timeout,
                comment_posts=reddit_comment_posts if reddit else 0,
                comment_sleep=0 if reddit else sleep_between,
            )
            results.append(result)
            if reddit and (result.rate_limited or gate.blocked):
                reddit_blocked = True
            if not reddit:
                time.sleep(sleep_between)
    return results
