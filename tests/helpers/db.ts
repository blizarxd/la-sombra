import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { createInMemoryDb, type Db } from "@/db/client";

/** Fresh in-memory database with the real migrations applied. */
export function testDb(): Db {
  const db = createInMemoryDb();
  migrate(db, { migrationsFolder: path.join(__dirname, "..", "..", "drizzle") });
  return db;
}
