"""Collector 는 LLM 없이 동작해야 한다. 가짜 HTTP 응답으로 검증."""

from __future__ import annotations

from pathlib import Path

import pytest

from collector.collector import fetch_source
from collector.db import connect, init_db

SCHEMA = Path(__file__).resolve().parents[1] / "db" / "schema.sql"

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <item>
    <title>Resident Evil Requiem Release Date Revealed</title>
    <link>https://example.com/re9?utm_source=rss</link>
    <pubDate>Mon, 15 Sep 2025 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Capcom announced&lt;/p&gt;</description>
  </item>
  <item>
    <title>No link item</title>
    <description>skipped</description>
  </item>
</channel></rss>
"""


class FakeResponse:
    def __init__(self, content: bytes, status_code: int = 200, headers: dict | None = None):
        self.content = content
        self.status_code = status_code
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeClient:
    def __init__(self, response: FakeResponse):
        self.response = response

    def get(self, url, headers=None, timeout=None):
        self.last_url = url
        return self.response


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "test.db")
    init_db(c, SCHEMA)
    c.execute(
        "INSERT INTO sources (name, feed_url, type, kind, enabled, weight, lang, created_at) "
        "VALUES ('Test', 'https://example.com/feed', 'rss', 'article', 1, 1.0, 'en', "
        "'2025-09-15T00:00:00Z')"
    )
    yield c
    c.close()


def _source(conn):
    return conn.execute("SELECT * FROM sources WHERE id = 1").fetchone()


def test_fetch_parses_and_inserts(conn):
    result = fetch_source(conn, _source(conn), client=FakeClient(FakeResponse(RSS.encode())), timeout=5)
    assert result.ok and result.entries == 2 and result.new_items == 1 and result.skipped == 1

    row = conn.execute("SELECT * FROM raw_items").fetchone()
    assert row["canonical_url"] == "https://example.com/re9"
    assert row["description"] == "Capcom announced"
    assert row["status"] == "new"          # collector 는 'new' 로만 넣는다
    assert row["published_at"].startswith("2025-09-15")


def test_second_fetch_is_deduped(conn):
    client = FakeClient(FakeResponse(RSS.encode()))
    fetch_source(conn, _source(conn), client=client, timeout=5)
    second = fetch_source(conn, _source(conn), client=client, timeout=5)
    assert second.new_items == 0 and second.duplicate == 1
    assert conn.execute("SELECT COUNT(*) c FROM raw_items").fetchone()["c"] == 1


CONTENT_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Test Feed</title>
  <item>
    <title>IGN style item</title>
    <link>https://example.com/ign</link>
    <description>Short teaser.</description>
    <content:encoded><![CDATA[<p>Full body paragraph that is much longer than the teaser.</p>]]></content:encoded>
  </item>
  <item>
    <title>Summary only item</title>
    <link>https://example.com/sum</link>
    <description>Only a summary here, and it is longer than the empty content.</description>
  </item>
</channel></rss>
"""


def test_prefers_longer_text_when_feed_has_content(conn):
    """content:encoded 에 본문이 있는 피드(IGN 등)는 그걸 써야 한다 — 요약만 쓰면 본문을 버린다."""
    fetch_source(conn, _source(conn), client=FakeClient(FakeResponse(CONTENT_FEED.encode())), timeout=5)
    rows = {r["title"]: r["description"] for r in conn.execute("SELECT title, description FROM raw_items")}
    assert rows["IGN style item"].startswith("Full body paragraph")
    assert rows["Summary only item"].startswith("Only a summary here")


def test_same_source_same_title_is_skipped(conn):
    """URL 이 달라도 같은 소스에 같은 제목이 이미 있으면 새 항목으로 안 넣는다."""
    feed = """<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>Team Fortress 2 Update Released</title>
            <link>https://example.com/tf2-1</link></item>
      <item><title>Team Fortress 2 Update Released</title>
            <link>https://example.com/tf2-2</link></item>
    </channel></rss>"""
    result = fetch_source(conn, _source(conn), client=FakeClient(FakeResponse(feed.encode())), timeout=5)
    assert result.new_items == 1 and result.duplicate == 1
    assert conn.execute("SELECT COUNT(*) c FROM raw_items").fetchone()["c"] == 1


def test_not_modified_304(conn):
    conn.execute("UPDATE sources SET etag = 'abc' WHERE id = 1")
    result = fetch_source(conn, _source(conn),
                          client=FakeClient(FakeResponse(b"", status_code=304)), timeout=5)
    assert result.not_modified and result.new_items == 0


def test_http_error_recorded(conn):
    result = fetch_source(conn, _source(conn),
                          client=FakeClient(FakeResponse(b"", status_code=500)), timeout=5)
    assert not result.ok and "500" in result.error
    assert conn.execute("SELECT COUNT(*) c FROM source_fetches").fetchone()["c"] == 1


def test_reddit_due_respects_interval(conn):
    from datetime import datetime, timedelta, timezone

    from collector.collector import reddit_due

    src = dict(_source(conn))
    src["last_fetched_at"] = None
    assert reddit_due(src, 3600) is True
    src["last_fetched_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    assert reddit_due(src, 3600) is False
    old = datetime.now(timezone.utc) - timedelta(hours=2)
    src["last_fetched_at"] = old.isoformat().replace("+00:00", "Z")
    assert reddit_due(src, 3600) is True
