import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(rootDir, "data");
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(join(dataDir, "web.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.exec(readFileSync(join(rootDir, "src/schema.sql"), "utf8"));

export type SqlParams = ReadonlyArray<unknown>;

export function query<T>(sql: string, params: SqlParams = []): T[] {
  return sqlite.prepare(sql).all(...params) as T[];
}

export function run(sql: string, params: SqlParams = []): { changes: number } {
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes };
}

export function exec(sql: string): void {
  sqlite.exec(sql);
}
