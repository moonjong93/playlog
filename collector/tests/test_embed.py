"""임베딩 백엔드 검증 — 네트워크 없이 (httpx.MockTransport + 가짜 embedder)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from collector.db import connect, init_db
from collector.embed import (OpenRouterEmbedder, embed_pending, purge_other_models,
                             reset_for_reembed, similarity_sample)

SCHEMA = Path(__file__).resolve().parents[1] / "db" / "schema.sql"


def _embedder(handler, **kw) -> OpenRouterEmbedder:
    e = OpenRouterEmbedder("https://or/api/v1", "secret", "liquid/x:free",
                           min_interval=0.0, **kw)
    e._client = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer secret"},
    )
    return e


def _ok(n: int):
    return httpx.Response(200, json={"data": [{"index": i, "embedding": [3.0, 4.0]}
                                              for i in range(n)]})


# ---------------------------------------------------------------- OpenRouter
def test_prompt_and_auth_header():
    seen: dict = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return _ok(1)

    _embedder(handler).embed(["제목\n요약"])
    assert seen["auth"] == "Bearer secret"
    assert seen["body"]["input"] == ["document: 제목\n요약"]      # 프롬프트는 우리가 붙인다
    assert seen["body"]["model"] == "liquid/x:free"


def test_retries_on_429_then_succeeds():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "slow"})
        return _ok(1)

    out = _embedder(handler, max_retries=2).embed(["a"])
    assert len(out) == 1 and calls["n"] == 2


def test_gives_up_after_max_retries():
    def handler(request):
        return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "slow"})

    with pytest.raises(RuntimeError, match="재시도 초과"):
        _embedder(handler, max_retries=1).embed(["a"])


def test_token_limit_splits_batch():
    calls: list[int] = []

    def handler(request):
        n = len(json.loads(request.content)["input"])
        calls.append(n)
        if n > 1:  # 컨텍스트 초과는 400 으로 거절된다(절단 아님)
            return httpx.Response(400, json={"error": {"message":
                          "Embedding input has 1043 tokens, exceeding the model maximum of 512."}})
        return _ok(n)

    out = _embedder(handler).embed(["a", "b", "c"])
    assert len(out) == 3
    assert calls[0] == 3 and calls.count(1) == 3


def test_token_limit_shrinks_single_input():
    lengths: list[int] = []

    def handler(request):
        text = json.loads(request.content)["input"][0]
        lengths.append(len(text))
        if len(text) > 100:
            return httpx.Response(400, json={"error": {"message":
                          "Embedding input has 900 tokens, exceeding the model maximum of 512."}})
        return _ok(1)

    assert len(_embedder(handler).embed(["x" * 400])) == 1
    assert lengths[0] > 400 and lengths[-1] <= 110      # 프롬프트 포함 길이


# ---------------------------------------------------------------- DB
class FakeEmbedder:
    model = "fake-model"

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts):
        self.calls.append(list(texts))
        return [[1.0, 0.0] for _ in texts]

    def info(self):
        return "fake"

    def close(self):
        pass


def _rows(conn, model="fake-model") -> list:
    return conn.execute("SELECT raw_item_id, model, dim, vec FROM item_embeddings "
                        "WHERE model = ? ORDER BY raw_item_id", (model,)).fetchall()


@pytest.fixture()
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    init_db(c, SCHEMA)
    c.execute("INSERT INTO sources (name, feed_url, kind, enabled, weight, lang, created_at) "
              "VALUES ('S1', 'https://s1/feed', 'article', 1, 1.0, 'en', '2026-01-01T00:00:00Z')")
    c.execute("INSERT INTO sources (name, feed_url, kind, enabled, weight, lang, created_at) "
              "VALUES ('S2', 'https://s2/feed', 'article', 1, 1.0, 'en', '2026-01-01T00:00:00Z')")
    for i, (source_id, status) in enumerate(((1, "new"), (2, "new"), (1, "filtered"), (1, "new"))):
        c.execute("INSERT INTO raw_items (source_id, url, canonical_url, url_hash, title, "
                  "description, fetched_at, status) VALUES (?, ?, ?, ?, ?, ?, "
                  "'2026-01-01T00:00:00Z', ?)",
                  (source_id, f"https://s/{i}", f"https://s/{i}", f"h{i}", f"제목 {i}", "요약", status))
    yield c
    c.close()


def test_embed_pending_skips_filtered(conn):
    e = FakeEmbedder()
    stats = embed_pending(conn, e, batch=2, max_chars=10)
    assert stats["items"] == 3 and stats["vectors"] == 3 and stats["dim"] == 2
    assert len(e.calls) == 2                                  # batch=2 → 두 번
    assert conn.execute("SELECT COUNT(*) c FROM raw_items WHERE status='embedded'").fetchone()["c"] == 3
    assert conn.execute("SELECT status FROM raw_items WHERE id=3").fetchone()["status"] == "filtered"
    assert len(_rows(conn)) == 3

    # 두 번째 호출은 처리할 게 없다
    assert embed_pending(conn, FakeEmbedder(), batch=2)["items"] == 0


def test_reset_for_reembed_and_purge(conn):
    embed_pending(conn, FakeEmbedder(), batch=2)
    assert reset_for_reembed(conn, "fake-model") == 0          # 이미 이 모델로 되어 있다
    assert reset_for_reembed(conn, "other-model") == 3         # 다른 모델 → 다시 큐로
    assert conn.execute("SELECT COUNT(*) c FROM raw_items WHERE status='new'").fetchone()["c"] == 3
    assert reset_for_reembed(conn, "other-model") == 0         # filtered 는 안 건드린다

    assert purge_other_models(conn, "other-model") == 3
    assert _rows(conn) == []


def test_similarity_sample_skips_same_source(conn):
    """같은 매체 쌍은 빼고 센다 — 다른 매체가 같은 사건을 쓴 것을 보는 지표다."""
    embed_pending(conn, FakeEmbedder(), batch=2)
    sim = similarity_sample(conn, "fake-model", threshold=0.99)
    assert sim["items"] == 3
    assert sim["pairs"] == 2                                   # 3쌍 중 S1↔S1 한 쌍 제외
    assert sim["buckets"]["0.85+"] == 2
    assert sim["top"][0][0] == pytest.approx(1.0)              # 동일 벡터 → 1.0
    assert similarity_sample(conn, "fake-model", threshold=1.01)["top"] == []
