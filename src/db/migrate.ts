import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { getDb, getDbPath, type Db } from "./client";

export function runMigrations(db: Db) {
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
}

// Run directly via `npm run db:migrate`
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("db/migrate.ts");
if (invokedDirectly) {
  const db = getDb();
  runMigrations(db);
  console.log(`[db:migrate] migrations applied to ${getDbPath()}`);
}
