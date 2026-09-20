"""임베딩 백엔드 — 로컬(내장) / OpenRouter.

목적: writer 가 "같은 사건"을 묶을 때 쓸 벡터를 미리 만들어 둔다.
      임베딩은 LLM 이 아니다. collector 는 LLM 을 호출하지 않는다.

백엔드 (EMBED_PROVIDER)
  local      : sentence-transformers 로 모델을 프로세스 안에서 직접 로드(HF 자동 다운로드). 기본값
  openrouter : HTTP. 테스트/임시용. OPENROUTER_API_KEY 필요

프롬프트 (EMBED_PROMPT)
  LFM2.5-Embedding 계열은 비대칭 프롬프트를 쓴다. 모델의 config_sentence_transformers.json 에
  default_prompt_name 이 null 이라 encode() 가 자동으로 붙여주지 않는다 → 우리가 붙인다.
  우리는 문서(패시지)만 다루므로 'document' 를 쓴다.

벡터는 저장 전에 L2 정규화한다 → 코사인 유사도 = 내적.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import struct
import time
from typing import Protocol

import httpx

log = logging.getLogger(__name__)

# 모델이 학습된 프롬프트. 문자열을 그대로 쓰면 .env 파싱에서 뒤 공백이 날아가므로
# 이름으로만 고르게 한다.
PROMPTS = {"document": "document: ", "query": "query: ", "none": ""}

_RETRYABLE_STATUS = {429, 500, 502, 503, 529}
_TOKEN_LIMIT = re.compile(r"exceeding the model maximum", re.I)
_MIN_INPUT_CHARS = 80    # 토큰 초과 시 축소 하한. 이보다 줄여도 실패하면 포기한다


# ---------------------------------------------------------------- 백엔드
class Embedder(Protocol):
    """백엔드 공통 인터페이스. model 은 DB(item_embeddings.model) 키다."""

    model: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...
    def info(self) -> str: ...
    def close(self) -> None: ...


class LocalEmbedder:
    """sentence-transformers 인프로세스 백엔드.

    torch/sentence-transformers 는 여기서 처음 import 한다(lazy) →
    무거운 의존성을 안 깐 환경에서도 collect/noise/report 는 정상 동작한다.
    """

    def __init__(self, model_id: str, model: str, *, prompt: str = "document",
                 device: str = "cpu", dtype: str = "float32", max_seq_len: int = 512) -> None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:  # noqa: BLE001
            raise RuntimeError(
                "로컬 임베딩에는 sentence-transformers 가 필요합니다.\n"
                "  설치: uv sync --extra local-embed\n"
                "  또는 EMBED_PROVIDER=openrouter 로 실행"
            ) from exc

        self._device = device
        self.model = model
        self.model_id = model_id
        self.prompt = PROMPTS.get(prompt, "")
        self.dtype = dtype
        log.info("임베딩 모델 로드: %s (device=%s, dtype=%s) — 최초 실행은 다운로드로 오래 걸린다",
                 model_id, device, dtype)
        self._st = SentenceTransformer(model_id, trust_remote_code=True, device=device,
                                       model_kwargs={"dtype": dtype})
        self._st.max_seq_length = max_seq_len

    def embed(self, texts: list[str]) -> list[list[float]]:
        prepared = [self.prompt + t for t in texts]
        vecs = self._st.encode(
            prepared, batch_size=len(prepared), normalize_embeddings=True, show_progress_bar=False,
        )
        return [list(map(float, v)) for v in vecs]

    def info(self) -> str:
        return (f"local  {self.model_id}  device={self._device} dtype={self.dtype}  "
                f"prompt={self.prompt!r}  db_model={self.model}")

    def close(self) -> None:
        self._st = None


class _Retryable(Exception):
    def __init__(self, status: int, retry_after: float | None):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.retry_after = retry_after


class _TooLong(Exception):
    """모델 컨텍스트 초과 — 절단이 아니라 400 으로 거절된다(실측)."""


class OpenRouterEmbedder:
    """OpenRouter 의 OpenAI 호환 /embeddings HTTP 백엔드."""

    def __init__(self, base_url: str, api_key: str, model: str, *, prompt: str = "document",
                 timeout: float = 120.0, max_retries: int = 4, min_interval: float = 0.5) -> None:
        if not api_key:
            raise RuntimeError(
                "OpenRouter 임베딩에는 API 키가 필요합니다.\n"
                "  .env 에 EMBED_API_KEY=... (또는 OPENROUTER_API_KEY) 를 넣어라"
            )
        self.base = base_url.rstrip("/")
        self.model = model
        self.prompt = PROMPTS.get(prompt, "")
        self.max_retries = max_retries
        self.min_interval = min_interval
        self._last_request = 0.0
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )

    def embed(self, texts: list[str]) -> list[list[float]]:
        return self._embed_prepared([self.prompt + t for t in texts])

    # ---------- 내부 ----------
    def _embed_prepared(self, prepared: list[str]) -> list[list[float]]:
        for attempt in range(self.max_retries + 1):
            try:
                return self._post(prepared)
            except _TooLong as exc:
                if len(prepared) > 1:
                    mid = len(prepared) // 2
                    log.warning("입력이 컨텍스트 초과 — 배치 %d → %d + %d 로 분할",
                                len(prepared), mid, len(prepared) - mid)
                    return (self._embed_prepared(prepared[:mid])
                            + self._embed_prepared(prepared[mid:]))
                if len(prepared[0]) <= _MIN_INPUT_CHARS:
                    raise RuntimeError(f"입력을 줄여도 컨텍스트 초과: {exc}") from exc
                prepared = [prepared[0][: max(_MIN_INPUT_CHARS, len(prepared[0]) // 2)]]
                log.warning("컨텍스트 초과 — 단건 입력을 %d자로 축소", len(prepared[0]))
            except _Retryable as exc:
                if attempt >= self.max_retries:
                    raise RuntimeError(f"임베딩 재시도 초과: {exc}") from exc
                delay = exc.retry_after if exc.retry_after is not None else min(2.0 * 2 ** attempt, 30.0)
                log.warning("임베딩 서버 %s — %.1f초 후 재시도 %d/%d",
                            exc, delay, attempt + 1, self.max_retries)
                time.sleep(delay)
        raise RuntimeError("임베딩 재시도 초과")

    def _post(self, prepared: list[str]) -> list[list[float]]:
        gap = self.min_interval - (time.monotonic() - self._last_request)
        if gap > 0:
            time.sleep(gap)
        resp = self._client.post(f"{self.base}/embeddings",
                                 json={"model": self.model, "input": prepared})
        self._last_request = time.monotonic()

        if resp.status_code == 400 and _TOKEN_LIMIT.search(resp.text):
            raise _TooLong(resp.text)
        if resp.status_code in _RETRYABLE_STATUS:
            raw = resp.headers.get("Retry-After")
            try:
                retry_after = float(raw) if raw else None
            except ValueError:
                retry_after = None
            raise _Retryable(resp.status_code, retry_after)
        resp.raise_for_status()

        data = resp.json().get("data") or []
        if len(data) != len(prepared):
            raise RuntimeError(f"임베딩 개수 불일치: {len(data)} != {len(prepared)}")
        data.sort(key=lambda d: d.get("index", 0))
        return [d["embedding"] for d in data]

    def info(self) -> str:
        return f"openrouter  {self.base}  prompt={self.prompt!r}  db_model={self.model}"

    def close(self) -> None:
        self._client.close()


def make_embedder(settings) -> Embedder:
    """설정 → 백엔드. provider 별 기본 model 키는 settings 가 정한다."""
    provider = settings.embed_provider
    if provider == "local":
        return LocalEmbedder(settings.embed_local_model, settings.embed_model,
                             prompt=settings.embed_prompt, device=settings.embed_device,
                             dtype=settings.embed_dtype)
    if provider == "openrouter":
        return OpenRouterEmbedder(settings.embed_base_url, settings.embed_api_key,
                                  settings.embed_model, prompt=settings.embed_prompt,
                                  timeout=settings.embed_timeout)
    raise RuntimeError(f"알 수 없는 EMBED_PROVIDER: {provider} (local | openrouter)")


# ---------------------------------------------------------------- 벡터 유틸
def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(v * v for v in vec))
    return [v / n for v in vec] if n > 1e-9 else vec


def pack(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def unpack(blob: bytes) -> list[float]:
    return list(struct.unpack(f"{len(blob) // 4}f", blob))


def embed_text(item_row, max_chars: int) -> str:
    """임베딩 입력: 제목 + 요약 앞부분. (프롬프트는 백엔드가 붙인다)"""
    desc = (item_row["description"] or "").strip().replace("\n", " ")
    return f"{item_row['title']}\n{desc[:max_chars]}".strip()


# ---------------------------------------------------------------- DB 작업
def embed_pending(conn, embedder: Embedder, *, batch: int = 32, max_chars: int = 400,
                  limit: int | None = None) -> dict:
    """status='new' 이고 아직 이 모델의 임베딩이 없는 항목을 배치로 처리."""
    sql = """
        SELECT ri.* FROM raw_items ri
        LEFT JOIN item_embeddings e
               ON e.raw_item_id = ri.id AND e.model = ?
         WHERE ri.status = 'new' AND e.raw_item_id IS NULL
         ORDER BY ri.id
    """
    params: list = [embedder.model]
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        return {"items": 0, "vectors": 0, "batches": 0, "dim": 0, "seconds": 0.0}

    from .db import utcnow

    started = time.time()
    stored = 0
    dim = 0
    batches = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i : i + batch]
        texts = [embed_text(r, max_chars) for r in chunk]
        vectors = embedder.embed(texts)
        batches += 1
        now = utcnow()
        for row, text, vec in zip(chunk, texts, vectors):
            vec = normalize(vec)
            dim = len(vec)
            conn.execute(
                """
                INSERT OR REPLACE INTO item_embeddings
                    (raw_item_id, model, dim, vec, text_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (row["id"], embedder.model, dim, pack(vec), _sha(text), now),
            )
            conn.execute("UPDATE raw_items SET status='embedded' WHERE id = ?", (row["id"],))
            stored += 1
        conn.commit()
        log.info("embed: %d/%d 완료 (배치 %d)", min(i + batch, len(rows)), len(rows), batches)

    return {
        "items": len(rows), "vectors": stored, "batches": batches,
        "dim": dim, "seconds": round(time.time() - started, 1),
    }


def reset_for_reembed(conn, model: str) -> int:
    """다른 모델 벡터만 가진 항목을 다시 큐로 넣는다 (embedded → new).

    filtered 는 건드리지 않는다(노이즈 판단은 임베딩과 별개).
    """
    cur = conn.execute(
        """
        UPDATE raw_items SET status='new'
         WHERE status='embedded'
           AND NOT EXISTS (SELECT 1 FROM item_embeddings e
                            WHERE e.raw_item_id = raw_items.id AND e.model = ?)
        """,
        (model,),
    )
    return cur.rowcount


def purge_other_models(conn, keep: str) -> int:
    """다른 모델 벡터를 지운다. 백엔드를 바꾸면 벡터 공간이 달라져 섞으면 안 된다."""
    return conn.execute("DELETE FROM item_embeddings WHERE model <> ?", (keep,)).rowcount


def similarity_sample(conn, model: str, *, sample: int = 100, threshold: float = 0.72) -> dict:
    """최근 기사끼리 코사인 유사도 분포.

    **같은 매체 쌍은 뺀다.** 다른 매체가 같은 사건을 쓴 것을 찾는 게 목적이라
    같은 매체끼리(4Gamer↔4Gamer) 비교는 신호가 아니다.
    """
    rows = conn.execute(
        """
        SELECT e.vec, ri.id, ri.source_id FROM item_embeddings e
          JOIN raw_items ri ON ri.id = e.raw_item_id
          JOIN sources s ON s.id = ri.source_id
         WHERE e.model = ? AND s.kind = 'article'
         ORDER BY ri.id DESC LIMIT ?
        """,
        (model, sample),
    ).fetchall()
    vecs = [(r["id"], r["source_id"], unpack(r["vec"])) for r in rows]
    buckets = {"0.85+": 0, "0.72-0.85": 0, "0.60-0.72": 0, "0.50-0.60": 0, "<0.50": 0}
    pairs = 0
    top: list[tuple[float, int, int]] = []
    for i in range(len(vecs)):
        for j in range(i + 1, len(vecs)):
            if vecs[i][1] == vecs[j][1]:
                continue
            a, b = vecs[i][2], vecs[j][2]
            sim = sum(x * y for x, y in zip(a, b))       # 정규화되어 있어 내적 = 코사인
            pairs += 1
            key = ("0.85+" if sim >= 0.85 else "0.72-0.85" if sim >= 0.72
                   else "0.60-0.72" if sim >= 0.60 else "0.50-0.60" if sim >= 0.50 else "<0.50")
            buckets[key] += 1
            if sim >= threshold:
                top.append((sim, vecs[i][0], vecs[j][0]))
    top.sort(reverse=True)
    return {"pairs": pairs, "items": len(vecs), "buckets": buckets, "top": top[:8]}
