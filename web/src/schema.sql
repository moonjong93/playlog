CREATE TABLE IF NOT EXISTS articles (
  slug TEXT PRIMARY KEY,
  title_ko TEXT NOT NULL,
  lede_ko TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  story_id INTEGER,
  sources_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
