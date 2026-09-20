"""로컬 markdown + (선택) 웹 ingest HTTP."""

from __future__ import annotations

import html
import logging
import re
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_LITERAL_NL = re.compile(r"\\n")

MAX_TAGS = 3
TAG_MAX_LEN = 20
_TAG_SPLIT = re.compile(r"[,/]")
_TAG_ALLOWED = re.compile(r"[^가-힣a-zA-Z0-9 ·+\-&_.:]")
_TAG_SPACES = re.compile(r"\s+")


def normalize_tags(value: object) -> list[str]:
    """모델이 낸 태그를 웹 계약에 맞게 정리한다.

    문자열이면 쉼표/`/`로 나눈다. 각 항목은 선행 `#` 제거 → 허용 문자만 남김
    → 연속 공백 1칸 → 20자 컷 → trim. 2자 미만은 버리고, 대소문자 무시 중복은
    먼저 나온 표기를 남긴다. 최대 3개.
    """
    if isinstance(value, str):
        raw = _TAG_SPLIT.split(value)
    elif isinstance(value, list):
        raw = value
    else:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        tag = item.strip().lstrip("#")
        tag = _TAG_ALLOWED.sub("", tag)
        tag = _TAG_SPACES.sub(" ", tag)[:TAG_MAX_LEN].strip()
        if len(tag) < 2:
            continue
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


def unescape_newlines(text: str) -> str:
    """모델이 JSON 문자열 안에서 \\n 을 두 번 이스케이프한 경우(리터럴 \\n) 실제 줄바꿈으로 되돌린다."""
    return _LITERAL_NL.sub("\n", text or "")


def ascii_slug(title: str, fallback: str = "story") -> str:
    s = _SLUG_RE.sub("-", (title or "").lower()).strip("-")
    s = s[:48].strip("-")
    return s or fallback


def render_markdown(*, story_id: int, slug: str, title: str, lede: str, body: str,
                    model: str, run_id: int | None, sources: list[dict],
                    status: str, prompt_version: str,
                    tags: list[str] | None = None) -> str:
    src_lines = []
    for s in sources:
        src_lines.append(f"  - name: {s['name']}\n    url: {s['url']}\n    role: {s['role']}")
    src_block = "\n".join(src_lines) if src_lines else "  []"
    lede_s = unescape_newlines(lede or "").strip()
    body_s = unescape_newlines(body or "").strip()
    parts = [
        "---",
        f"story_id: {story_id}",
        f"slug: {slug}",
        f"status: {status}",
        f"model: {model}",
        f"run_id: {run_id or ''}",
        f"prompt_version: {prompt_version}",
        *([f"tags: [{', '.join(tags)}]"] if tags is not None else []),
        "sources:",
        src_block,
        "---",
        "",
        f"# {title}",
        "",
    ]
    if lede_s:
        parts += [lede_s, ""]
    parts.append(body_s)
    parts.append("")
    return "\n".join(parts)


def write_file(out_dir: Path, *, date: str, slug: str, text: str) -> Path:
    folder = out_dir / date
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{slug}.md"
    path.write_text(text, encoding="utf-8")
    return path


_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)]+)\)")
_I = re.compile(r"\*(.+?)\*")
_HREF = re.compile(r"https?://[^\s)>\"]+")


def md_to_html(text: str) -> str:
    """마크다운 문단 → HTML. 출처 목록을 여기서 지우지 않는다."""
    raw = (text or "").strip()
    if not raw:
        return ""
    chunks = []
    for para in re.split(r"\n\s*\n", raw):
        esc = html.escape(para.strip())
        esc = _LINK.sub(r'<a href="\2">\1</a>', esc)
        esc = _I.sub(r"<i>\1</i>", esc)
        esc = esc.replace("\n", "<br>\n")
        chunks.append(f"<p>{esc}</p>")
    return "\n".join(chunks)


def _citation_only(para: str, source_urls: set[str], source_names: set[str] | None = None) -> bool:
    """이 문단이 기사 문장이 아니라, 이미 sources 로 가는 출처 나열인지."""
    if not source_urls:
        return False
    hrefs = set(_HREF.findall(para.replace("&amp;", "&")))
    if not hrefs or not hrefs <= source_urls:
        return False
    names = {n.lower() for n in (source_names or set()) if n}
    text = re.sub(r"<[^>]+>", " ", para)
    text = _HREF.sub(" ", text)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"(출처|source)\s*[:：]?", " ", text, flags=re.I)
    tokens = [t for t in re.split(r"[^\w가-힣]+", text, flags=re.UNICODE) if t]
    if not tokens:
        return True
    return all(t.lower() in names for t in tokens)


def prose_body(md: str, sources: list[dict]) -> str:
    """본문은 글만. 출처는 ingest 의 sources 필드가 담당한다."""
    urls = {str(s.get("url") or "").strip() for s in sources if s.get("url")}
    names = {str(s.get("name") or "").strip() for s in sources if s.get("name")}
    paras = [p.strip() for p in re.split(r"\n\s*\n", (md or "").strip()) if p.strip()]
    while paras and _citation_only(paras[-1], urls, names):
        paras.pop()
    return "\n\n".join(paras)


def post_article(base_url: str, api_key: str, payload: dict, *,
                 timeout: float = 20.0, client: httpx.Client | None = None) -> int:
    """POST /internal/articles. 201 또는 200. 호출측이 WEB_URL 빈 값은 안 넘긴다."""
    own = client is None
    http = client or httpx.Client(timeout=timeout)
    try:
        resp = http.post(
            f"{base_url.rstrip('/')}/internal/articles",
            json=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        return resp.status_code
    finally:
        if own:
            http.close()


def _drop_lede_echo(body_md: str, lede: str) -> str:
    first = (lede or "").strip().split("\n")[0].strip()
    if len(first) < 12:
        return body_md
    paras = [p.strip() for p in re.split(r"\n\s*\n", (body_md or "").strip()) if p.strip()]
    if paras and (first[:24] in paras[0] or paras[0][:24] in first):
        paras = paras[1:]
    return "\n\n".join(paras)


def ingest_payload(*, slug: str, title: str, lede: str, body_md: str,
                   published_at: str, story_id: int,
                   sources: list[dict], tags: list[str] | None = None) -> dict:
    from .db import utcnow
    lede = unescape_newlines(lede)
    body_md = unescape_newlines(body_md)
    body_md = _drop_lede_echo(body_md, lede)
    body_md = prose_body(body_md, sources)
    payload = {
        "slug": slug,
        "title_ko": title,
        "lede_ko": lede or "",
        "body_html": md_to_html(body_md),
        "published_at": published_at or utcnow(),
        "updated_at": utcnow(),
        "sources": [
            {
                "name": s.get("name") or "",
                "url": s.get("url") or "",
                "role": s.get("role") or "",
                **({"comments": s["comments"]} if s.get("comments") else {}),
            }
            for s in sources
        ],
        "story_id": story_id,
    }
    if tags is not None:
        payload["tags"] = tags
    return payload
