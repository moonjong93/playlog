from __future__ import annotations

import json

import httpx
import pytest

from writer.feature import (
    FeatureError,
    feature_md_to_html,
    feature_payload,
    load_feature,
    publish_feature,
)

FRONT_MATTER = """---
slug: pubg-asia-stars-2026
title: 한 번의 방플이 대회를 멈췄다
lede: |
  첫 줄 요약
  둘째 줄 요약
published_at: 2026-09-28T09:00:00+09:00
tags: [특집, PUBG, e스포츠]
sources:
  - name: 연합뉴스
    url: https://example.com/yna
    role: news
---
## 무슨 일이 있었나

본문 **첫 문단**이다.

> 인용 문장

- 항목 하나
- 항목 둘

1. 순서 하나
2. 순서 둘
"""


def write_md(tmp_path, text: str):
    path = tmp_path / "feature.md"
    path.write_text(text, encoding="utf-8")
    return path


def test_load_feature_parses_front_matter(tmp_path):
    doc = load_feature(write_md(tmp_path, FRONT_MATTER))
    assert doc["slug"] == "pubg-asia-stars-2026"
    assert doc["title"] == "한 번의 방플이 대회를 멈췄다"
    assert doc["lede"].startswith("첫 줄 요약")
    assert doc["tags"] == ["특집", "PUBG", "e스포츠"]
    assert doc["sources"][0]["name"] == "연합뉴스"
    assert doc["body_md"].startswith("## 무슨 일이 있었나")


def test_load_feature_rejects_bad_files(tmp_path):
    with pytest.raises(FeatureError):
        load_feature(write_md(tmp_path, "## 제목만 있다"))
    with pytest.raises(FeatureError):
        load_feature(write_md(tmp_path, "---\nslug: s\ntitle: t\n본문"))
    with pytest.raises(FeatureError):
        load_feature(write_md(tmp_path, "---\ntitle: t\n---\n본문"))
    with pytest.raises(FeatureError):
        load_feature(write_md(tmp_path, "---\nslug: s\n---\n본문"))
    with pytest.raises(FeatureError):
        load_feature(write_md(tmp_path, "---\nslug: s\ntitle: t\n---\n"))
    with pytest.raises(FeatureError):
        load_feature(tmp_path / "없는파일.md")


def test_md_to_html_builds_supported_blocks():
    html = feature_md_to_html(
        "## 큰 제목\n\n### 작은 제목\n\n문단 **굵게** *기울임* [링크](https://a.example/b)\n\n"
        "> 인용\n\n- 하나\n- 둘\n\n1. 첫째\n2. 둘째\n\n---\n\n마지막 문단"
    )
    assert "<h2>큰 제목</h2>" in html
    assert "<h3>작은 제목</h3>" in html
    assert "<strong>굵게</strong>" in html
    assert "<em>기울임</em>" in html
    assert '<a href="https://a.example/b">링크</a>' in html
    assert "<blockquote>인용</blockquote>" in html
    assert "<ul><li>하나</li>\n<li>둘</li></ul>" in html
    assert "<ol><li>첫째</li>\n<li>둘째</li></ol>" in html
    assert "<hr>" in html
    assert html.index("<h2>") < html.index("<h3>")
    assert html.rstrip().endswith("<p>마지막 문단</p>")


def test_md_to_html_joins_lines_in_paragraph_and_escapes():
    html = feature_md_to_html("첫 줄\n둘째 줄")
    assert html == "<p>첫 줄<br>\n둘째 줄</p>"
    assert "<script>" not in feature_md_to_html("<script>x</script>")
    assert "&lt;script&gt;" in feature_md_to_html("<script>x</script>")


def test_feature_payload_contract(tmp_path):
    doc = load_feature(write_md(tmp_path, FRONT_MATTER))
    payload = feature_payload(doc, published_at="2026-09-28T00:00:00Z", updated_at="2026-09-28T01:00:00Z")
    assert payload["slug"] == "pubg-asia-stars-2026"
    assert payload["story_id"] is None
    assert payload["published_at"] == "2026-09-28T09:00:00+09:00"  # front matter 우선
    assert payload["updated_at"] == "2026-09-28T01:00:00Z"
    assert payload["tags"] == ["특집", "PUBG", "e스포츠"]
    assert payload["sources"] == [
        {"name": "연합뉴스", "url": "https://example.com/yna", "role": "news"}
    ]
    assert "<h2>무슨 일이 있었나</h2>" in payload["body_html"]


def test_feature_payload_published_at_fallback_and_tags_optional(tmp_path):
    doc = load_feature(write_md(tmp_path, "---\nslug: s\ntitle: t\n---\n본문"))
    payload = feature_payload(doc, published_at="2026-09-28T00:00:00Z", updated_at="2026-09-28T00:00:00Z")
    assert payload["published_at"] == "2026-09-28T00:00:00Z"
    assert "tags" not in payload  # front matter에 tags 키가 없으면 웹의 기존 태그 유지
    empty = feature_payload(
        load_feature(write_md(tmp_path, "---\nslug: s\ntitle: t\ntags: []\n---\n본문")),
        published_at="2026-09-28T00:00:00Z", updated_at="2026-09-28T00:00:00Z",
    )
    assert empty["tags"] == []


def test_publish_feature_posts_payload(tmp_path):
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"ok": True})

    doc = load_feature(write_md(tmp_path, FRONT_MATTER))
    client = httpx.Client(transport=httpx.MockTransport(handler))
    code = publish_feature(
        doc, base_url="https://web.example", api_key="dev-key",
        published_at="2026-09-28T00:00:00Z", updated_at="2026-09-28T00:00:00Z",
        client=client,
    )
    assert code == 201
    assert seen["auth"] == "Bearer dev-key"
    assert seen["body"]["slug"] == "pubg-asia-stars-2026"
    assert "<h2>" in seen["body"]["body_html"]
