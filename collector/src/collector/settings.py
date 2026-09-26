"""환경변수/.env 로딩 (의존성 없이 최소 구현)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]   # collector/

# 일부 매체는 봇 UA 를 차단한다(Eurogamer). Reddit 은 반대로 브라우저 UA 를 막는다.
# → 기본값은 브라우저 UA, 피드별로 sources.user_agent 로 덮어쓴다.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


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
    sources_file: Path
    noise_rules_file: Path
    schema_file: Path

    collect_interval: int
    fetch_timeout: float
    user_agent: str
    reddit_comment_posts: int
    reddit_sleep: float
    reddit_min_interval: int
    reddit_user: str
    reddit_feed: str

    embed_provider: str
    embed_model: str
    embed_local_model: str
    embed_device: str
    embed_dtype: str
    embed_prompt: str
    embed_api_key: str
    embed_base_url: str
    embed_batch: int
    embed_timeout: float
    embed_max_chars: int
    sim_threshold: float


def load_settings() -> Settings:
    load_dotenv()                                 # collector/.env
    load_dotenv(PROJECT_ROOT.parent / ".env")      # 루트 .env (없으면 무시, 프로젝트 .env 우선)
    root = PROJECT_ROOT
    # 백엔드별 DB 키(모델 이름)가 다르다. 벡터 공간이 다르므로 섞으면 안 된다.
    provider = _str("EMBED_PROVIDER", "local").lower()
    default_model = {
        "local": "lfm2.5-embedding-350m",
        "openrouter": "liquid/lfm-2.5-embedding-350m:free",
    }.get(provider, "lfm2.5-embedding-350m")
    return Settings(
        db_path=Path(_str("COLLECTOR_DB", str(root / "data" / "news.db"))).expanduser(),
        sources_file=Path(_str("SOURCES_FILE", str(root / "config" / "sources.yaml"))).expanduser(),
        noise_rules_file=Path(_str("NOISE_RULES", str(root / "config" / "noise_rules.yaml"))).expanduser(),
        schema_file=root / "db" / "schema.sql",
        collect_interval=_int("COLLECT_INTERVAL", 900),
        fetch_timeout=_float("FETCH_TIMEOUT", 20.0),
        user_agent=_str("NEWS_USER_AGENT", DEFAULT_USER_AGENT),
        reddit_comment_posts=_int("REDDIT_COMMENT_POSTS", 2),
        reddit_sleep=_float("REDDIT_SLEEP", 20.0),
        reddit_min_interval=_int("REDDIT_MIN_INTERVAL", 3600),
        reddit_user=_str("REDDIT_USER"),
        reddit_feed=_str("REDDIT_FEED"),
        embed_provider=provider,
        embed_model=_str("EMBED_MODEL", default_model),
        embed_local_model=_str("EMBED_LOCAL_MODEL", "LiquidAI/LFM2.5-Embedding-350M"),
        embed_device=_str("EMBED_DEVICE", "cpu"),
        embed_dtype=_str("EMBED_DTYPE", "bfloat16"),
        embed_prompt=_str("EMBED_PROMPT", "document"),
        embed_api_key=_str("EMBED_API_KEY") or _str("OPENROUTER_API_KEY"),
        embed_base_url=_str("EMBED_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/"),
        embed_batch=_int("EMBED_BATCH", 32),
        embed_timeout=_float("EMBED_TIMEOUT", 120.0),
        embed_max_chars=_int("EMBED_MAX_CHARS", 400),
        sim_threshold=_float("SIM_THRESHOLD", 0.72),
    )
