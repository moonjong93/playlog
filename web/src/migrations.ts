import type { Database } from "better-sqlite3";
import { toSearchText } from "./sanitize.ts";

export type Migration = {
  version: number;
  up: (db: Database) => void;
};

/** v1: 최초 스키마(articles). */
const V1 = `
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
`;

/** v2: 검색/댓글/정규화. */
const V2 = `
ALTER TABLE articles ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
UPDATE articles SET section = '' WHERE section NOT IN ('industry','announce','ship','talk','review');
CREATE INDEX IF NOT EXISTS idx_articles_section_published ON articles(section, published_at DESC);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES articles(slug) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  body TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id, created_at DESC);
`;

/** v3: 자유 태그(article_tags)로 전환하고 section 컬럼을 제거한다. */
const V3 = `
CREATE TABLE IF NOT EXISTS article_tags (
  slug TEXT NOT NULL REFERENCES articles(slug) ON DELETE CASCADE,
  tag  TEXT NOT NULL,
  PRIMARY KEY (slug, tag)
);
CREATE INDEX IF NOT EXISTS idx_article_tags_tag ON article_tags(tag, slug);
INSERT OR IGNORE INTO article_tags (slug, tag)
  SELECT slug, CASE section
    WHEN 'industry' THEN '업계·사업'
    WHEN 'announce' THEN '발표·신작'
    WHEN 'ship'     THEN '출시·패치'
    WHEN 'talk'     THEN '발언'
    WHEN 'review'   THEN '리뷰·공략'
  END
  FROM articles
  WHERE section IN ('industry','announce','ship','talk','review');
DROP INDEX IF EXISTS idx_articles_section_published;
ALTER TABLE articles DROP COLUMN section;
`;

/** v2에서 추가된 search_text를 기존 행에 채운다. */
function backfillSearchText(db: Database): void {
  const rows = db
    .prepare("SELECT slug, body_html FROM articles WHERE search_text = ''")
    .all() as { slug: string; body_html: string }[];
  if (rows.length === 0) return;
  const update = db.prepare("UPDATE articles SET search_text = ? WHERE slug = ?");
  for (const row of rows) update.run(toSearchText(row.body_html), row.slug);
}

export const migrations: Migration[] = [
  { version: 1, up: (db) => db.exec(V1) },
  {
    version: 2,
    up: (db) => {
      db.exec(V2);
      backfillSearchText(db);
    },
  },
  { version: 3, up: (db) => db.exec(V3) },
];

/** PRAGMA user_version 기준으로 미적용 마이그레이션만 순서대로 실행한다. */
export function applyMigrations(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
