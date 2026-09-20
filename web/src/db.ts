import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.ts";
import { applyMigrations } from "./migrations.ts";

mkdirSync(dirname(env.dbPath), { recursive: true });

const sqlite = new Database(env.dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
applyMigrations(sqlite);

export type SqlParams = ReadonlyArray<unknown>;

export function query<T>(sql: string, params: SqlParams = []): T[] {
  return sqlite.prepare(sql).all(...params) as T[];
}

export function queryOne<T>(sql: string, params: SqlParams = []): T | undefined {
  return sqlite.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: SqlParams = []): {
  changes: number;
  lastInsertRowid: number;
} {
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
}

export function exec(sql: string): void {
  sqlite.exec(sql);
}

/** 테스트 정리용. 앱 런타임에서는 호출하지 않는다. */
export function close(): void {
  sqlite.close();
}
