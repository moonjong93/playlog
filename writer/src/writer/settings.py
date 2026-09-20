"""환경변수/.env 로딩 (의존성 없이 최소 구현). collector.settings 와 같은 방식."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]   # writer/


def load_dotenv(path: Path | None = None) -> None:
    env_path = path or PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def _str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int) -> int:
    try:
        return int(_str(name) or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(_str(name) or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    db_path: Path
    schema_file: Path
    prompts_file: Path
    out_dir: Path

    embed_model: str

    interval: int
    lookback_hours: int
    rag_window_hours: int
    merge_days: int

    sim_threshold: float
    rag_article_min: float
    rag_community_min: float
    merge_followup: float
    merge_related: float
    rag_article_k: int
    rag_community_k: int
    min_singleton_desc: int
    min_singleton_weight: float
    max_per_run: int
    batch_limit: int
    web_url: str
    web_api_key: str

    openrouter_base: str
    openrouter_api_key: str
    writer_model: str
    editor_model: str
    bench_models: str
    max_tokens: int
    timeout: float
    min_interval: float
    temperature: float
    reasoning_effort: str


def load_settings() -> Settings:
    load_dotenv()
    root = PROJECT_ROOT
    default_db = root.parent / "collector" / "data" / "news.db"
    api_key = _str("OPENROUTER_API_KEY") or _str("WRITER_API_KEY")
    writer_model = _str("WRITER_MODEL", "openai/gpt-5.6-luna")
    editor_model = _str("EDITOR_MODEL") or writer_model
    return Settings(
        db_path=Path(_str("NEWS_DB") or _str("COLLECTOR_DB") or str(default_db)).expanduser(),
        schema_file=root / "db" / "schema.sql",
        prompts_file=Path(_str("PROMPTS_FILE", str(root / "config" / "prompts.yaml"))).expanduser(),
        out_dir=Path(_str("WRITER_OUT", str(root / "out"))).expanduser(),
        embed_model=_str("EMBED_MODEL", "lfm2.5-embedding-350m"),
        interval=_int("WRITER_INTERVAL", 10800),
        lookback_hours=_int("WRITER_LOOKBACK", 36),
        rag_window_hours=_int("RAG_WINDOW_HOURS", 168),
        merge_days=_int("MERGE_DAYS", 14),
        sim_threshold=_float("SIM_THRESHOLD", 0.72),
        rag_article_min=_float("RAG_ARTICLE_MIN", 0.65),
        rag_community_min=_float("RAG_COMMUNITY_MIN", 0.58),
        merge_followup=_float("MERGE_FOLLOWUP", 0.80),
        merge_related=_float("MERGE_RELATED", 0.70),
        rag_article_k=_int("RAG_ARTICLE_K", 8),
        rag_community_k=_int("RAG_COMMUNITY_K", 3),
        min_singleton_desc=_int("MIN_SINGLETON_DESC", 200),
        min_singleton_weight=_float("MIN_SINGLETON_WEIGHT", 1.5),
        max_per_run=_int("WRITER_MAX_PER_RUN", 0),
        batch_limit=_int("WRITER_BATCH", 100),
        web_url=_str("WEB_URL").rstrip("/"),
        web_api_key=_str("WEB_API_KEY") or _str("WEB_INGEST_TOKEN"),
        openrouter_base=_str("OPENROUTER_BASE", "https://openrouter.ai/api/v1").rstrip("/"),
        openrouter_api_key=api_key,
        writer_model=writer_model,
        editor_model=editor_model,
        bench_models=_str(
            "BENCH_MODELS",
            "inclusionai/ling-3.0-flash,deepseek/deepseek-v4-flash,"
            "google/gemma-4-26b-a4b-it,google/gemma-4-31b-it,"
            "upstage/solar-pro4,google/gemini-2.5-flash-lite,openai/gpt-5.6-luna",
        ),
        max_tokens=_int("WRITER_MAX_TOKENS", 10000),
        timeout=_float("WRITER_TIMEOUT", 180.0),
        min_interval=_float("WRITER_MIN_INTERVAL", 0.5),
        temperature=_float("WRITER_TEMPERATURE", 0.3),
        reasoning_effort=_str("WRITER_REASONING", ""),
    )
