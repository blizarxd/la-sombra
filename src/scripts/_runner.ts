import { getDb, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { AdapterError } from "@/lib/adapters/types";
import { log } from "@/lib/logger";

/**
 * Common wrapper for operator scripts:
 * - ensures the schema is migrated,
 * - surfaces REAL errors (never fakes data on API failure),
 * - exits non-zero on failure so schedulers can alert.
 */
export async function runScript(name: string, main: (db: Db) => Promise<void> | void) {
  const started = Date.now();
  log.info(`[${name}] starting`);
  try {
    const db = getDb();
    runMigrations(db);
    await main(db);
    log.info(`[${name}] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (err instanceof AdapterError) {
      log.error(`[${name}] UPSTREAM API FAILURE — stopping, not faking data.`);
      log.error(`[${name}] ${err.message}`);
    } else {
      log.error(`[${name}] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    process.exitCode = 1;
  }
}

export function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}
