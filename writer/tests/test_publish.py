from __future__ import annotations

import json

import httpx
import pytest

from writer.publish import (
    ingest_payload,
    md_to_html,
    normalize_tags,
    post_article,
    prose_body,
    render_markdown,
)


def test_md_to_html_paragraphs_and_links():
    html = md_to_html("안녕 *세계*.\n\n두 번째 문단")
    assert "<p>" in html
    assert "<i>세계</i>" in html
    assert "<script>" not in md_to_html("<script>x</script>")


def test_prose_body_drops_citation_list_already_in_sources():
    md = "본문이다.\n\n- [IGN](https://ign.example/a)\n- [Gematsu](https://g.example/a)"
    src = [
        {"name": "IGN", "url": "https://ign.example/a"},
        {"name": "Gematsu", "url": "https://g.example/a"},
    ]
    assert prose_body(md, src) == "본문이다."
    assert "ign.example" in md_to_html(md)  # 변환기는 안 지운다


def test_post_article_sends_bearer_and_json():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    payload = ingest_payload(
        slug="s1", title="제목", lede="리드", body_md="본문",
        tags=["출시·패치"], published_at="2026-09-17T00:00:00Z",
        story_id=1, sources=[{"name": "IGN", "url": "https://i.example", "role": "seed"}],
    )
    code = post_article("https://web.example", "dev-key", payload, client=client)
    assert code == 201
    assert seen["auth"] == "Bearer dev-key"
    assert seen["body"]["slug"] == "s1"
    assert seen["body"]["title_ko"] == "제목"
    assert "<p>" in seen["body"]["body_html"]
    payload2 = ingest_payload(
        slug="s2", title="T",
        lede="넷마블은 17일 도쿄게임쇼에서 PV를 공개했다.",
        body_md="넷마블은 17일 도쿄게임쇼에서 PV를 공개했다.\n\n이어서 실기 시연이 있었다.\n\n- [4Gamer](https://www.4gamer.net/a)",
        tags=["넷마블", "도쿄게임쇼"], published_at="2026-09-17T00:00:00Z",
        story_id=2, sources=[{"name": "4Gamer", "url": "https://www.4gamer.net/a", "role": "seed"}],
    )
    assert "실기 시연" in payload2["body_html"]
    assert "4gamer.net" not in payload2["body_html"]
    assert payload2["body_html"].count("<p>") == 1
    with_comments = ingest_payload(
        slug="s3", title="T", lede="L", body_md="본문",
        tags=["발언"], published_at="2026-09-17T00:00:00Z", story_id=3,
        sources=[{
            "name": "Reddit r/Games", "url": "https://reddit.com/r/Games/x",
            "role": "community",
            "comments": [{"author": "alice", "text": "good pick"}],
        }],
    )
    assert with_comments["sources"][0]["comments"][0]["text"] == "good pick"


def test_ingest_payload_unescapes_literal_newlines():
    from writer.publish import unescape_newlines
    assert unescape_newlines("가.\n나.") == "가.\n나."          # 진짜 줄바꿈은 그대로
    assert unescape_newlines(r"가.\n나.") == "가.\n나."        # 리터럴 \n → 실제 줄바꿈
    payload = ingest_payload(
        slug="s", title="T", lede=r"첫 줄\n둘째 줄", body_md="본문",
        published_at="2026-09-17T00:00:00Z", story_id=9, sources=[],
    )
    assert payload["lede_ko"] == "첫 줄\n둘째 줄"


def test_post_article_raises_on_401():
    def handler(request):
        return httpx.Response(401, text="no")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        post_article("https://web.example", "bad", {"slug": "x"}, client=client)


def test_normalize_tags_from_string_and_list():
    assert normalize_tags("닌텐도, #TGS2026 / 닌텐도 스위치 / ㄱ") == ["닌텐도", "TGS2026", "닌텐도 스위치"]
    assert normalize_tags(["닌텐도", "TGS2026"]) == ["닌텐도", "TGS2026"]
    assert normalize_tags(None) == []
    assert normalize_tags(123) == []
    assert normalize_tags({"tags": ["닌텐도"]}) == []


def test_normalize_tags_dedupes_case_insensitively():
    assert normalize_tags(["닌텐도", "닌텐도", "Nintendo", "NINTENDO"]) == ["닌텐도", "Nintendo"]


def test_normalize_tags_drops_short_truncates_and_strips_chars():
    assert normalize_tags(["가", "", "  ", "#"]) == []
    assert normalize_tags(["가나", "다라", "마바", "사아"]) == ["가나", "다라", "마바"]
    assert normalize_tags(["닌텐도!!", "TGS/2026"]) == ["닌텐도", "TGS2026"]
    assert normalize_tags(["  닌텐도   스위치  "]) == ["닌텐도 스위치"]
    assert normalize_tags(["가" * 30]) == ["가" * 20]


def test_ingest_payload_tags_key_present_only_when_given():
    base = dict(
        slug="s", title="T", lede="L", body_md="본문",
        published_at="2026-09-17T00:00:00Z", story_id=1, sources=[],
    )
    assert "tags" not in ingest_payload(**base)
    assert "tags" not in ingest_payload(**base, tags=None)
    assert ingest_payload(**base, tags=[])["tags"] == []
    payload = ingest_payload(**base, tags=["닌텐도", "TGS2026"])
    assert payload["tags"] == ["닌텐도", "TGS2026"]
    assert "section" not in payload


def test_render_markdown_front_matter_tags():
    kwargs = dict(
        story_id=1, slug="s", title="제목", lede="리드", body="본문",
        model="m", run_id=None, sources=[], status="published", prompt_version="abc",
    )
    text = render_markdown(**kwargs, tags=["닌텐도", "TGS2026"])
    assert "tags: [닌텐도, TGS2026]" in text
    assert "story_id: 1" in text
    assert "sources:" in text
    assert "tags: []" in render_markdown(**kwargs, tags=[])
    # 재발행(tags=None)은 웹의 기존 태그를 모르므로 front matter 에도 쓰지 않는다.
    assert "tags:" not in render_markdown(**kwargs, tags=None)


def test_ingest_payload_drops_markdown_headings():
    """예전 기사에 남은 '### 커뮤니티 반응' 헤딩이 본문에 노출되지 않는다."""
    base = dict(
        slug="s", title="제목", lede="리드", published_at="2026-09-20T00:00:00Z",
        story_id=1, sources=[],
    )
    payload = ingest_payload(
        **base,
        body_md="본문 첫 문단이다.\n\n### 커뮤니티 반응\n\n반응 요약 문단이다.",
    )
    assert "###" not in payload["body_html"]
    assert "커뮤니티 반응" not in payload["body_html"]
    assert "반응 요약 문단이다" in payload["body_html"]
