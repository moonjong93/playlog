-- =========================================================
-- collector DB — 수집기가 소유하는 테이블만
--
-- 소유 경계 (중요)
--   collector : sources / raw_items / source_fetches / item_embeddings
--   writer    : writer_runs / writing_items / stories / story_sources / llm_usage
--               → writer 는 이 DB 를 읽되 위 4개 테이블은 건드리지 않는다.
--
-- raw_items 는 append-only. 수집기가 만든 뒤 수정하지 않는다.
-- =========================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ---------- sources ----------
CREATE TABLE IF NOT EXISTS sources (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    feed_url        TEXT    NOT NULL UNIQUE,
    type            TEXT    NOT NULL DEFAULT 'rss',   -- rss | reddit
    kind            TEXT    NOT NULL DEFAULT 'article', -- article | community
    enabled         INTEGER NOT NULL DEFAULT 1,
    weight          REAL    NOT NULL DEFAULT 1.0,
    lang            TEXT    NOT NULL DEFAULT 'en',
    user_agent      TEXT,          -- Reddit: 정중한 전용 UA 필수
    impersonate     TEXT,          -- Reddit: 'safari' (TLS 지문 위장)
    etag            TEXT,
    last_modified   TEXT,
    last_fetched_at TEXT,
    last_status     TEXT,
    last_error      TEXT,
    created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled);

-- ---------- raw_items ----------
CREATE TABLE IF NOT EXISTS raw_items (
    id            INTEGER PRIMARY KEY,
    source_id     INTEGER NOT NULL,
    url           TEXT    NOT NULL,
    canonical_url TEXT,
    url_hash      TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    description   TEXT,
    published_at  TEXT,
    fetched_at    TEXT    NOT NULL,
    content       TEXT,            -- 2차 수집(댓글 등). 1차에서는 비어 있음
    content_hash  TEXT,
    -- new → (noise 필터) filtered
    --     → (임베딩 완료) embedded
    --     → 문제 발생 failed
    status        TEXT    NOT NULL DEFAULT 'new',
    noise_reason  TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    FOREIGN KEY (source_id) REFERENCES sources(id),
    UNIQUE (source_id, url_hash)
);

CREATE INDEX IF NOT EXISTS idx_raw_items_status  ON raw_items(status, id);
CREATE INDEX IF NOT EXISTS idx_raw_items_hash    ON raw_items(url_hash);
CREATE INDEX IF NOT EXISTS idx_raw_items_fetched ON raw_items(fetched_at);
CREATE INDEX IF NOT EXISTS idx_raw_items_source  ON raw_items(source_id, id);
-- 같은 소스에 같은 제목이 다시 오는 것을 막는다(Steam News 처럼 같은 제목을 새 URL 로 계속 발행하는 피드)
CREATE INDEX IF NOT EXISTS idx_raw_items_src_title ON raw_items(source_id, title);

-- ---------- item_embeddings ----------
-- bge-m3 벡터. float32 BLOB (dim * 4 bytes). 1024차원 = 4KB/건
-- text_hash 는 임베딩 대상 텍스트가 바뀌었는지 판단용.
CREATE TABLE IF NOT EXISTS item_embeddings (
    raw_item_id INTEGER NOT NULL,
    model       TEXT    NOT NULL,
    dim         INTEGER NOT NULL,
    vec         BLOB    NOT NULL,
    text_hash   TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    PRIMARY KEY (raw_item_id, model),
    FOREIGN KEY (raw_item_id) REFERENCES raw_items(id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_model ON item_embeddings(model);

-- ---------- source_fetches ----------
CREATE TABLE IF NOT EXISTS source_fetches (
    id           INTEGER PRIMARY KEY,
    source_id    INTEGER NOT NULL,
    started_at   TEXT    NOT NULL,
    finished_at  TEXT,
    http_status  INTEGER,
    entries      INTEGER NOT NULL DEFAULT 0,
    new_items    INTEGER NOT NULL DEFAULT 0,
    duplicate    INTEGER NOT NULL DEFAULT 0,
    not_modified INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE INDEX IF NOT EXISTS idx_source_fetches_source ON source_fetches(source_id, id);

-- writer 가 나중에 쓸 자리 (지금은 만들지 않는다, 경계 표시용 주석)
-- CREATE TABLE writer_runs(...);
-- CREATE TABLE writing_items(...);

INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
