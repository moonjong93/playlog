-- =========================================================
-- writer DB — writer 가 소유하는 테이블만
--
-- 같은 news.db 를 쓰되 collector 테이블은 읽기만 한다.
--   collector : sources / raw_items / source_fetches / item_embeddings
--   writer    : 아래 전부
-- =========================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS writer_runs (
    id                INTEGER PRIMARY KEY,
    started_at        TEXT    NOT NULL,
    finished_at       TEXT,
    status            TEXT    NOT NULL DEFAULT 'running',  -- running | ok | error
    items_seen        INTEGER NOT NULL DEFAULT 0,
    stories_new       INTEGER NOT NULL DEFAULT 0,
    stories_updated   INTEGER NOT NULL DEFAULT 0,
    articles_written  INTEGER NOT NULL DEFAULT 0,
    error             TEXT
);

CREATE TABLE IF NOT EXISTS stories (
    id               INTEGER PRIMARY KEY,
    slug             TEXT    UNIQUE,
    title_ko         TEXT,
    lede_ko          TEXT,
    status           TEXT    NOT NULL DEFAULT 'clustered',
    -- clustered | drafted | edited | written | published | skipped
    skip_reason      TEXT,
    needs_review     INTEGER NOT NULL DEFAULT 0,
    window_start     TEXT,
    window_end       TEXT,
    source_count     INTEGER NOT NULL DEFAULT 0,
    community_count  INTEGER NOT NULL DEFAULT 0,
    importance       REAL    NOT NULL DEFAULT 0,
    centroid_blob    BLOB,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status, id);
CREATE INDEX IF NOT EXISTS idx_stories_updated ON stories(updated_at);

CREATE TABLE IF NOT EXISTS story_sources (
    story_id    INTEGER NOT NULL,
    raw_item_id INTEGER NOT NULL,
    role        TEXT    NOT NULL,          -- seed | retrieved | community
    similarity  REAL    NOT NULL DEFAULT 1.0,
    PRIMARY KEY (story_id, raw_item_id),
    FOREIGN KEY (story_id) REFERENCES stories(id)
);

CREATE INDEX IF NOT EXISTS idx_story_sources_item ON story_sources(raw_item_id);

CREATE TABLE IF NOT EXISTS story_relations (
    from_id INTEGER NOT NULL,
    to_id   INTEGER NOT NULL,
    kind    TEXT    NOT NULL,              -- followup | related
    score   REAL    NOT NULL,
    PRIMARY KEY (from_id, to_id, kind),
    FOREIGN KEY (from_id) REFERENCES stories(id),
    FOREIGN KEY (to_id)   REFERENCES stories(id)
);

CREATE TABLE IF NOT EXISTS writing_items (
    raw_item_id INTEGER PRIMARY KEY,
    story_id    INTEGER NOT NULL,
    run_id      INTEGER,
    role        TEXT    NOT NULL,
    similarity  REAL    NOT NULL DEFAULT 1.0,
    claimed_at  TEXT    NOT NULL,
    FOREIGN KEY (story_id) REFERENCES stories(id),
    FOREIGN KEY (run_id)   REFERENCES writer_runs(id)
);

CREATE TABLE IF NOT EXISTS articles (
    id              INTEGER PRIMARY KEY,
    story_id        INTEGER NOT NULL,
    run_id          INTEGER,
    stage           TEXT    NOT NULL,      -- written (구: draft | edited)
    model           TEXT    NOT NULL,
    prompt_version  TEXT,
    title_ko        TEXT    NOT NULL,
    lede_ko         TEXT,
    body_md         TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    FOREIGN KEY (story_id) REFERENCES stories(id),
    FOREIGN KEY (run_id)   REFERENCES writer_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_articles_story ON articles(story_id, id);

CREATE TABLE IF NOT EXISTS llm_usage (
    id                 INTEGER PRIMARY KEY,
    run_id             INTEGER,
    story_id           INTEGER,
    role               TEXT    NOT NULL,   -- writer | editor
    model              TEXT    NOT NULL,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL,
    request_id         TEXT,
    created_at         TEXT    NOT NULL,
    FOREIGN KEY (run_id)   REFERENCES writer_runs(id),
    FOREIGN KEY (story_id) REFERENCES stories(id)
);

CREATE TABLE IF NOT EXISTS writer_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 모델 경합. 발행 파이프(stories/articles) 와 분리한다.
CREATE TABLE IF NOT EXISTS bench_runs (
    id          INTEGER PRIMARY KEY,
    task        TEXT    NOT NULL,          -- translate | write
    models      TEXT    NOT NULL,          -- comma-separated
    case_count  INTEGER NOT NULL DEFAULT 0,
    started_at  TEXT    NOT NULL,
    finished_at TEXT,
    status      TEXT    NOT NULL DEFAULT 'running',  -- running | ok | error
    report_path TEXT,
    error       TEXT
);

CREATE TABLE IF NOT EXISTS bench_cases (
    id          INTEGER PRIMARY KEY,
    run_id      INTEGER NOT NULL,
    raw_item_id INTEGER,
    story_id    INTEGER,
    source_name TEXT,
    lang        TEXT,
    title       TEXT    NOT NULL,
    input_text  TEXT    NOT NULL,
    FOREIGN KEY (run_id) REFERENCES bench_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_bench_cases_run ON bench_cases(run_id, id);

CREATE TABLE IF NOT EXISTS bench_outputs (
    id                 INTEGER PRIMARY KEY,
    run_id             INTEGER NOT NULL,
    case_id            INTEGER NOT NULL,
    model              TEXT    NOT NULL,
    title_ko           TEXT,
    body_md            TEXT,
    raw_text           TEXT,
    latency_ms         INTEGER,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL,
    error              TEXT,
    created_at         TEXT    NOT NULL,
    FOREIGN KEY (run_id)  REFERENCES bench_runs(id),
    FOREIGN KEY (case_id) REFERENCES bench_cases(id)
);

CREATE INDEX IF NOT EXISTS idx_bench_outputs_run ON bench_outputs(run_id, case_id, model);

INSERT OR IGNORE INTO writer_meta(key, value) VALUES ('schema_version', '1');
