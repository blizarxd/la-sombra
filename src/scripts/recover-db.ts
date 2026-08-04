import "../lib/env";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../db/client";
import { log } from "../lib/logger";

/**
 * 🚑 Corruption salvage — runs before the migrator, does nothing on a healthy DB.
 *
 * 2026-08-04: the Railway volume filled to 100% while SQLite was mid-write and
 * the database came back SQLITE_CORRUPT ("database disk image is malformed").
 * Every boot then died in db:migrate, so the service crash-looped and no
 * cleanup could run — checkpoint, VACUUM and even reads all refuse on a
 * malformed image.
 *
 * The way out uses a fact about this dataset: everything we actually care about
 * is TINY. The 4.6 GB is raw API payload logs (observed_trades,
 * market_snapshots, pnl_snapshots); the research — every paper trade, wallet
 * profile, gold cell, daily cut and rule version — is a few megabytes. So the
 * salvage copies ONLY the essential tables into a fresh database and leaves the
 * bloat behind. That recovers the analysis, repairs the corruption and drops
 * the volume from 4.6 GB to megabytes in a single pass.
 *
 * Corrupt pages are read around, not through: rows come out in rowid-ordered
 * chunks and a chunk that throws is skipped so one bad page costs a few rows
 * instead of the whole table. The count saved from every table is logged, and
 * the corrupt original is only deleted once paper_trades — the table the entire
 * strategy is built on — has actually been recovered.
 *
 * Paper-only: this moves rows between local files. No network, no orders.
 */

/**
 * Tables worth carrying across, in dependency-free order. The three big log
 * tables are deliberately ABSENT: they are re-fetchable API payloads, they are
 * what filled the disk, and they are the most likely home of the bad pages.
 */
const ESSENTIAL_TABLES = [
  "paper_trades", // ← the whole analysis rests on this one
  "wallet_profiles",
  "crema_cells",
  "crema_evolution",
  "daily_reports",
  "ai_analyses",
  "rule_sets",
  "rule_changes",
  "outcome_reviews",
  "combo_leg_resolutions",
  "elite_roster",
  "control_settings",
  "leaderboard_scans",
  "__drizzle_migrations", // keep migration history so db:migrate stays consistent
];

/** Rows per read/insert batch — small enough that one bad page costs little. */
const CHUNK = 500;

const fmt = (bytes: number) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
};

const sizeOf = (p: string): number => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};

/** Is the database readable? Returns null when it is fine, or the error text. */
export function checkIntegrity(dbPath: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // quick_check skips the expensive index cross-checks but still reads every
    // page — enough to catch a malformed image without scanning for minutes.
    const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
    const verdict = rows?.[0]?.quick_check ?? "unknown";
    return verdict === "ok" ? null : verdict;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    db?.close();
  }
}

/** Copy one table across, skipping chunks that sit on corrupt pages. */
function salvageTable(src: Database.Database, dest: Database.Database, table: string): { saved: number; skipped: number } {
  let saved = 0;
  let skipped = 0;

  // Recreate the table exactly as it was, so column types and constraints match
  // what Drizzle expects on the other side.
  let createSql: string | undefined;
  try {
    const row = src.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { sql: string }
      | undefined;
    createSql = row?.sql;
  } catch {
    return { saved: 0, skipped: 0 };
  }
  if (!createSql) return { saved: 0, skipped: 0 };

  try {
    dest.exec(createSql);
  } catch (err) {
    log.warn(`[recover:db] no se pudo crear ${table}: ${err instanceof Error ? err.message : String(err)}`);
    return { saved: 0, skipped: 0 };
  }

  let insert: Database.Statement | null = null;
  let lastRowid = 0;
  for (;;) {
    let batch: Array<Record<string, unknown>>;
    try {
      batch = src
        .prepare(`SELECT rowid AS __rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`)
        .all(lastRowid) as Array<Record<string, unknown>>;
    } catch {
      // This chunk sits on a bad page. Step over it and keep going: losing a few
      // hundred rows beats losing the table.
      skipped += CHUNK;
      lastRowid += CHUNK;
      if (skipped > 5_000_000) break; // pathological file — stop rather than spin
      continue;
    }
    if (batch.length === 0) break;

    for (const row of batch) {
      const rid = row.__rid as number;
      delete row.__rid;
      try {
        if (!insert) {
          const cols = Object.keys(row);
          insert = dest.prepare(
            `INSERT OR IGNORE INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`,
          );
        }
        insert.run(row);
        saved++;
      } catch {
        skipped++;
      }
      lastRowid = Math.max(lastRowid, rid);
    }
  }

  return { saved, skipped };
}

function main(): void {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    log.info("[recover:db] no hay base todavía — nada que recuperar");
    return;
  }

  const problem = checkIntegrity(dbPath);
  if (!problem) {
    log.info("[recover:db] integridad OK — no hace falta recuperar nada");
    return;
  }

  log.error(`[recover:db] BASE CORRUPTA: ${problem}`);
  log.warn("[recover:db] rescatando SOLO las tablas esenciales (los logs crudos se quedan atrás a propósito)");

  const dir = path.dirname(dbPath);
  const rescuedPath = path.join(dir, "la-sombra-rescued.db");
  fs.rmSync(rescuedPath, { force: true });
  fs.rmSync(`${rescuedPath}-wal`, { force: true });
  fs.rmSync(`${rescuedPath}-shm`, { force: true });

  let src: Database.Database | null = null;
  let dest: Database.Database | null = null;
  const results: Array<[string, number, number]> = [];

  try {
    src = new Database(dbPath, { readonly: true });
    dest = new Database(rescuedPath);
    dest.pragma("journal_mode = OFF"); // no journal: this file is built from scratch
    dest.pragma("synchronous = OFF"); // and rebuilt wholesale if anything fails

    for (const table of ESSENTIAL_TABLES) {
      const { saved, skipped } = salvageTable(src, dest, table);
      if (saved > 0 || skipped > 0) {
        results.push([table, saved, skipped]);
        log.info(`[recover:db] ${table}: ${saved} filas rescatadas${skipped > 0 ? `, ${skipped} perdidas` : ""}`);
      }
    }
  } catch (err) {
    log.error(`[recover:db] el rescate falló: ${err instanceof Error ? err.message : String(err)}`);
    src?.close();
    dest?.close();
    return;
  }

  const trades = results.find(([t]) => t === "paper_trades")?.[1] ?? 0;
  src.close();
  dest.close();

  // The gate: never destroy the original unless the table the entire strategy
  // is built on actually came across. A salvage that saved no trades saved
  // nothing worth having, and the corrupt file is then the better copy to keep.
  if (trades === 0) {
    log.error("[recover:db] 0 paper trades rescatados — NO se toca el original. Hace falta recuperación manual.");
    fs.rmSync(rescuedPath, { force: true });
    return;
  }

  const oldSize = sizeOf(dbPath);
  const newSize = sizeOf(rescuedPath);
  const corruptPath = `${dbPath}.corrupt`;

  try {
    fs.rmSync(corruptPath, { force: true });
    fs.renameSync(dbPath, corruptPath);
    fs.renameSync(rescuedPath, dbPath);
    // Sidecars belong to the old file; leaving them would confuse the new one.
    for (const s of ["-wal", "-shm"]) fs.rmSync(`${corruptPath}${s}`, { force: true });
    // Now that the good copy is in place, reclaim the gigabytes.
    fs.rmSync(corruptPath, { force: true });
    log.info(
      `[recover:db] LISTO: ${trades} paper trades rescatados · base ${fmt(oldSize)} → ${fmt(newSize)} · ` +
        `liberados ${fmt(oldSize - newSize)}`,
    );
  } catch (err) {
    log.error(`[recover:db] no se pudo intercambiar los archivos: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  main();
} catch (err) {
  log.error(`[recover:db] falló: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
