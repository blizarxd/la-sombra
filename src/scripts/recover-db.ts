import "../lib/env";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
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

/**
 * Tables whose INSERTs are dropped during a `.recover` rebuild. These are the
 * raw payload logs that filled the volume in the first place; carrying them
 * back would rebuild a 4.6 GB file onto a disk with megabytes free.
 */
const BLOAT_TABLES = ["observed_trades", "market_snapshots", "pnl_snapshots", "decision_journal"];

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

/**
 * Deep salvage via the sqlite3 CLI's `.recover`, which walks raw b-tree pages
 * instead of trusting the schema table — the only thing that still works once
 * sqlite_master itself is unreadable, which is where the library API gives up
 * and returns nothing at all.
 *
 * The dumped SQL is filtered on the way through: rows belonging to the raw
 * payload logs are dropped, so the rebuild stays in the megabytes a nearly full
 * volume can actually hold instead of recreating the 4.6 GB that caused this.
 */
function deepRecover(dbPath: string, rescuedPath: string): boolean {
  const sqlPath = `${rescuedPath}.sql`;
  fs.rmSync(sqlPath, { force: true });

  const dump = spawnSync("sqlite3", [dbPath, ".recover"], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: "buffer",
  });
  if (dump.error) {
    log.warn(`[recover:db] sqlite3 .recover no disponible: ${dump.error.message}`);
    return false;
  }
  const text = dump.stdout?.toString("utf8") ?? "";
  if (text.trim().length === 0) {
    log.warn("[recover:db] .recover no devolvió nada");
    return false;
  }

  // Drop the bloat tables entirely: their CREATEs and their INSERTs.
  const skip = new RegExp(`^(INSERT INTO|CREATE TABLE|CREATE INDEX)[^"']*["']?(${BLOAT_TABLES.join("|")})\\b`, "i");
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (skip.test(line.trim())) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  fs.writeFileSync(sqlPath, kept.join("\n"), "utf8");
  log.info(`[recover:db] .recover produjo ${kept.length} sentencias (${dropped} descartadas por ser logs crudos)`);

  const build = spawnSync("sqlite3", [rescuedPath], {
    input: fs.readFileSync(sqlPath),
    maxBuffer: 512 * 1024 * 1024,
  });
  fs.rmSync(sqlPath, { force: true });
  if (build.status !== 0) {
    // Partial rebuilds are normal here — report, then judge by what came out.
    log.warn(`[recover:db] la reconstrucción reportó errores: ${build.stderr?.toString("utf8").slice(0, 300)}`);
  }
  return fs.existsSync(rescuedPath) && sizeOf(rescuedPath) > 0;
}

/** How many paper trades made it into a rescued file (0 if unreadable). */
function tradesIn(dbFile: string): number {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbFile, { readonly: true });
    const r = db.prepare("SELECT COUNT(*) n FROM paper_trades").get() as { n: number };
    return r?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
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
  const oldSizeAtStart = sizeOf(dbPath);
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
    log.warn(`[recover:db] el rescate directo falló: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    src?.close();
    dest?.close();
  }

  let trades = results.find(([t]) => t === "paper_trades")?.[1] ?? 0;

  // PASS 2 — the library API reads through sqlite_master, so when THAT is the
  // damaged part it returns nothing at all (exactly what happened on the first
  // attempt: zero rows, zero errors, every table silently empty). `.recover`
  // does not trust the schema table — it walks raw b-tree pages — so it is the
  // only thing left that can still find the data.
  if (trades === 0) {
    log.warn("[recover:db] el rescate directo no sacó nada — intentando .recover (páginas crudas)");
    fs.rmSync(rescuedPath, { force: true });
    if (deepRecover(dbPath, rescuedPath)) {
      trades = tradesIn(rescuedPath);
      log.info(`[recover:db] .recover rescató ${trades} paper trades`);
    }
  }

  // The gate: never destroy the original unless the table the entire strategy
  // is built on actually came across. A salvage that saved no trades saved
  // nothing worth having, and the corrupt file is then the better copy to keep.
  if (trades === 0) {
    // Keep whatever `.recover` did manage to pull out. Even without trades it
    // may hold wallet profiles or gold cells, it is small, and it costs nothing
    // to park it next to the database for a later merge.
    let keptPath: string | null = null;
    if (fs.existsSync(rescuedPath) && sizeOf(rescuedPath) > 0) {
      keptPath = path.join(dir, `la-sombra-salvaged-${new Date().toISOString().slice(0, 10)}.db`);
      try {
        fs.rmSync(keptPath, { force: true });
        fs.renameSync(rescuedPath, keptPath);
        log.warn(`[recover:db] lo poco rescatado queda guardado en ${path.basename(keptPath)} (${fmt(sizeOf(keptPath))})`);
      } catch {
        keptPath = null;
      }
    }
    fs.rmSync(rescuedPath, { force: true });

    // Destroying 15 days of research is the operator's call, never the script's.
    // ALLOW_FRESH_START is that explicit consent: without it we stay down and
    // say so, because a crash-loop the operator can diagnose beats silently
    // deleting the thing they were trying to save.
    if (process.env.ALLOW_FRESH_START !== "1") {
      log.error("[recover:db] 0 paper trades rescatados — NO se toca el original.");
      log.error("[recover:db] Para arrancar de cero (BORRA la base corrupta), pon ALLOW_FRESH_START=1 en Railway.");
      return;
    }

    log.warn("[recover:db] ALLOW_FRESH_START=1 — borrando la base corrupta y arrancando limpio");
    try {
      for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${s}`, { force: true });
      log.warn(
        `[recover:db] base corrupta borrada (${fmt(oldSizeAtStart)} liberados). Las migraciones crearán una nueva vacía` +
          (keptPath ? `. Lo rescatado sigue en ${path.basename(keptPath)}` : ""),
      );
    } catch (err) {
      log.error(`[recover:db] no se pudo borrar la base corrupta: ${err instanceof Error ? err.message : String(err)}`);
    }
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
