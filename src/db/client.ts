import "../lib/env";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

let _db: Db | null = null;

export function getDbPath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "la-sombra.db");
}

/** Lazily open the local SQLite database (creates the data dir if needed). */
export function getDb(): Db {
  if (_db) return _db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  _db = drizzle(sqlite, { schema });
  return _db;
}

/** Create a throwaway in-memory database (used by tests). */
export function createInMemoryDb(): Db {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite, { schema });
}

export { schema };
