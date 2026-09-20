"""Reddit 인증 RSS · 게이트 · 수집 순서. 네트워크 없음."""

from __future__ import annotations

from pathlib import Path

import pytest

from collector.collector import fetch_source
from collector.db import connect, init_db
from collector.fetcher import Response
from collector.reddit import (
    GatedFetcher,
    RateLimitError,
    RedditGate,
    is_reddit_url,
    rss_first,
    with_reddit_auth,
)

SCHEMA = Path(__file__).resolve().parents[1] / "db" / "schema.sql"


def test_with_reddit_auth_appends_and_keeps_query():
    url = "https://www.reddit.com/r/Games/top/.rss?t=day&limit=50"
    out = with_reddit_auth(url, "alice", "tok")
    assert "t=day" in out and "limit=50" in out
    assert "user=alice" in out and "feed=tok" in out


def test_with_reddit_auth_noop_without_creds():
    url = "https://www.reddit.com/r/Games/.rss"
    assert with_reddit_auth(url, "", "") == url
    assert with_reddit_auth("https://www.ign.com/feed", "alice", "tok") == "https://www.ign.com/feed"


def test_is_reddit_url():
    assert is_reddit_url("https://www.reddit.com/r/Games/.rss")
    assert is_reddit_url("https://old.reddit.com/r/Games/.rss")
    assert not is_reddit_url("https://notreddit.com/r/Games/.rss")


def test_rss_first_puts_reddit_last():
    rows = [
        {"name": "Games", "feed_url": "https://www.reddit.com/r/Games/.rss"},
        {"name": "IGN", "feed_url": "https://feeds.ign.com/ign/all"},
        {"name": "pcgaming", "feed_url": "https://www.reddit.com/r/pcgaming/.rss"},
    ]
    names = [r["name"] for r in rss_first(rows)]
    assert names == ["IGN", "Games", "pcgaming"]


def test_gate_blocks_after_429():
    gate = RedditGate(min_interval=0)
    assert gate.blocked is False
    gate.observe(Response(429, b"", {"Retry-After": "30"}))
    assert gate.blocked is True


class _Inner:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def get(self, url, headers=None, timeout=None):
        self.urls.append(url)
        return self.responses.pop(0)


def test_gated_fetcher_rewrites_url_and_trips_on_429():
    inner = _Inner([Response(429, b"", {"x-ratelimit-reset": "9"})])
    gate = RedditGate(min_interval=0)
    client = GatedFetcher(inner, gate, user="alice", feed="tok")
    with pytest.raises(RateLimitError):
        client.get("https://www.reddit.com/r/Games/.rss?t=day")
    assert "user=alice" in inner.urls[0] and "feed=tok" in inner.urls[0]
    assert gate.blocked is True


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "test.db")
    init_db(c, SCHEMA)
    c.execute(
        "INSERT INTO sources (name, feed_url, type, kind, enabled, weight, lang, created_at) "
        "VALUES ('Reddit r/Games', 'https://www.reddit.com/r/Games/top/.rss', "
        "'rss', 'community', 1, 0.9, 'en', '2025-09-15T00:00:00Z')"
    )
    yield c
    c.close()


REDDIT_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>r/Games</title>
  <item>
    <title>First post</title>
    <link>https://www.reddit.com/r/Games/comments/aaa/first/</link>
  </item>
  <item>
    <title>Second post</title>
    <link>https://www.reddit.com/r/Games/comments/bbb/second/</link>
  </item>
</channel></rss>
"""


class SequenceClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def get(self, url, headers=None, timeout=None):
        self.urls.append(url)
        return self.responses.pop(0)


def test_comment_429_stops_remaining_comments(conn):
    """한 댓글이 429 면 다음 글 댓글을 두드리지 않는다."""
    client = SequenceClient([
        Response(200, REDDIT_RSS.encode(), {}),
        Response(429, b"", {}),
        Response(200, b"<feed/>", {}),  # 도달하면 안 됨
    ])
    src = conn.execute("SELECT * FROM sources WHERE id = 1").fetchone()
    result = fetch_source(conn, src, client=client, timeout=5, comment_posts=2, comment_sleep=0)
    assert result.ok and result.new_items == 2
    assert result.rate_limited is True
    assert len(client.urls) == 2  # 피드 + 댓글 1
    assert result.comments_saved == 0


COMMENT_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>First post</title>
    <link>https://www.reddit.com/r/Games/comments/aaa/first/</link>
  </item>
  <item>
    <title>/u/bob on a take</title>
    <description>this game is good</description>
    <link>https://www.reddit.com/r/Games/comments/aaa/first/c1/</link>
  </item>
</channel></rss>
"""


def test_backfills_comments_on_existing_items(conn):
    """top/day 는 금방 전량 중복이 된다. 댓글 없는 기존 글도 예산만큼 채운다."""
    conn.execute(
        "INSERT INTO raw_items (source_id, url, canonical_url, url_hash, title, fetched_at, status) "
        "VALUES (1, 'https://www.reddit.com/r/Games/comments/aaa/first/', "
        "'https://www.reddit.com/r/Games/comments/aaa/first/', 'h1', 'First post', "
        "'2025-09-15T00:00:00Z', 'embedded')"
    )
    only_first = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>First post</title>
    <link>https://www.reddit.com/r/Games/comments/aaa/first/</link>
  </item>
</channel></rss>
"""
    client = SequenceClient([
        Response(200, only_first.encode(), {}),
        Response(200, COMMENT_RSS.encode(), {}),
    ])
    src = conn.execute("SELECT * FROM sources WHERE id = 1").fetchone()
    result = fetch_source(conn, src, client=client, timeout=5, comment_posts=1, comment_sleep=0)
    assert result.duplicate >= 1 and result.comments_saved == 1
    blob = conn.execute("SELECT content FROM raw_items WHERE title='First post'").fetchone()["content"]
    assert "this game is good" in blob
    assert "/comments/aaa/first/.rss" in client.urls[1]
