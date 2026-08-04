import "../lib/env";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../db/client";
import { log } from "../lib/logger";

/**
 * 🧹 Disk-space guard — runs BEFORE anything else on boot.
 *
 * Written 2026-08-04 after the Railway volume hit 100% (5 GB) and took the
 * whole app down: SQLite could not write, so the service reported "Online"
 * while every request hung, then crashed on boot. The volume was not full of
 * RESEARCH data — it was full of RAW API PAYLOADS. Every observed trade stores
 * the exchange's full JSON (`raw_trade_json`), and the bot sees ~8,875 signals
 * a day; the same is true of market snapshots. Over a few weeks that is
 * gigabytes of blobs we already parsed into columns and never read again.
 *
 * THE RECOVERY PROBLEM this script exists to solve: at 100% capacity, freeing
 * space with SQL is a deadlock — DELETE needs journal space, VACUUM needs
 * scratch space, even a WAL checkpoint has to grow the main file. The only
 * operation that returns bytes while needing none is UNLINKING A FILE. So on a
 * critically full disk we drop the -wal/-shm sidecars first (STEP 0), which
 * costs at most the transactions not yet checkpointed and never corrupts the
 * database, then delete in small chunks so no single transaction needs a large
 * journal.
 *
 * WHAT THIS NEVER TOUCHES — the tables the whole analysis rests on:
 *   paper_trades, wallet_profiles, crema_cells, crema_evolution,
 *   daily_reports, ai_analyses, rule_sets, rule_changes, outcome_reviews,
 *   combo_leg_resolutions, elite_roster.
 * Not one simulated trade, rule version, or daily cut is ever deleted here.
 *
 * WHAT IT PRUNES — only re-fetchable raw payloads and high-frequency logs:
 *   · raw JSON blobs older than a few days (the parsed columns stay)
 *   · observed signals older than 3 weeks (already scored and journaled)
 *   · market/PnL snapshots past the window any chart actually draws
 *
 * Paper-only and read-only on the outside world: no network, no orders.
 */

const DAY = 24 * 3600 * 1000;

/** Retention windows, in days. Deliberately generous — this is a safety valve. */
export const RETENTION = {
  rawTradeJson: 3, // blank the payload, keep the row
  rawMarketJson: 2,
  decisionJson: 7, // reasons/risks text shown only in the recent journal view
  observedTrades: 21, // full row delete (already scored + journaled)
  marketSnapshots: 7,
  pnlSnapshots: 10, // the mark-to-market chart window
  leaderboardScans: 14,
};

/** Only rewrite the file when there is real slack to give back (see STEP 5). */
const VACUUM_THRESHOLD_BYTES = 200 * 1024 * 1024;

/** Below this much free disk, SQL-based cleanup deadlocks — see STEP 0. */
export const CRITICAL_FREE_BYTES = 150 * 1024 * 1024;

/**
 * Recovery retention: much tighter windows, used ONLY when the disk is
 * critically full. Every table here is a re-fetchable log; the matrices and
 * every strategy verdict read paper_trades, which this never touches.
 */
export const RECOVERY_RETENTION: typeof RETENTION = {
  rawTradeJson: 1,
  rawMarketJson: 1,
  decisionJson: 2,
  observedTrades: 5,
  marketSnapshots: 2,
  pnlSnapshots: 3,
  leaderboardScans: 2,
};

/**
 * VACUUM rebuilds the ENTIRE database into a temporary copy, so it needs free
 * space of roughly the database's own size. Running it on a full volume is not
 * merely useless — it is how the 2026-08-04 recovery attempt OOM-killed the
 * container: the rebuild ballooned memory to 8 GB and Railway shot it. So
 * VACUUM is gated on genuinely having room, and `--force-vacuum` can lower the
 * slack threshold but can NEVER override this.
 */
const VACUUM_HEADROOM_FACTOR = 1.15;

/** Rows per delete transaction, so no single journal has to be large. */
const DELETE_CHUNK = 4000;

const fmt = (bytes: number) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
};

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Free bytes on the volume holding `dir`, or null if unavailable. */
export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * STEP 0 — the only lever that works at 100%: unlink the WAL sidecars.
 *
 * Returns bytes freed. Losing an un-checkpointed WAL costs the most recent
 * commits (minutes of signals) and leaves the main database intact and
 * consistent as of its last checkpoint — a trade the outage has already made
 * for us, since nothing is being written at all while the disk is full.
 */
function emergencyUnlink(dbPath: string): number {
  let freed = 0;
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    const size = fileSize(p);
    if (size === 0) continue;
    try {
      fs.unlinkSync(p);
      freed += size;
      log.warn(`[prune:db] EMERGENCIA: borrado ${path.basename(p)} (${fmt(size)}) para poder trabajar`);
    } catch (err) {
      log.warn(`[prune:db] no se pudo borrar ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return freed;
}

/**
 * Sweep stray files off the volume.
 *
 * Recovery leaves debris: a half-built rescue database, the SQL dump it was
 * built from, a renamed corrupt original. Worse, `sqlite3 .recover` parks rows
 * whose table it cannot identify into `lost_and_found`, so a "rescued" file can
 * weigh gigabytes of unattributable junk. After the 2026-08-04 salvage the
 * volume was still 86% full with an empty database — all of it debris.
 *
 * A salvaged file is kept ONLY while it holds paper trades worth merging back;
 * otherwise it is junk occupying the space that caused the outage.
 */
function sweepStrayFiles(dir: string, dbPath: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  const keep = new Set([path.basename(dbPath), `${path.basename(dbPath)}-wal`, `${path.basename(dbPath)}-shm`]);
  for (const name of entries) {
    if (keep.has(name)) continue;
    const full = path.join(dir, name);
    let size = 0;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }

    const isSalvage = /^la-sombra-salvaged-.*\.db$/.test(name);
    const isDebris = /(\.corrupt$|^la-sombra-rescued\.db|\.sql$|-wal$|-shm$)/.test(name);

    if (isSalvage) {
      // Worth its space only if the trades actually came across.
      let trades = 0;
      let probe: Database.Database | null = null;
      try {
        probe = new Database(full, { readonly: true });
        trades = (probe.prepare("SELECT COUNT(*) n FROM paper_trades").get() as { n: number })?.n ?? 0;
      } catch {
        trades = 0;
      } finally {
        probe?.close();
      }
      if (trades > 0) {
        log.warn(`[prune:db] ${name} (${fmt(size)}) tiene ${trades} paper trades — SE CONSERVA para fusionarlo`);
        continue;
      }
      log.warn(`[prune:db] ${name} (${fmt(size)}) no tiene paper trades utilizables — borrado, solo ocupaba espacio`);
      try {
        fs.rmSync(full, { force: true });
      } catch (err) {
        log.warn(`[prune:db] no se pudo borrar ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (isDebris) {
      log.warn(`[prune:db] restos del rescate: borrando ${name} (${fmt(size)})`);
      try {
        fs.rmSync(full, { force: true });
      } catch (err) {
        log.warn(`[prune:db] no se pudo borrar ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (size > 50 * 1024 * 1024) {
      // Not ours to delete, but the operator must know what is eating the disk.
      log.warn(`[prune:db] archivo grande desconocido en el volumen: ${name} (${fmt(size)})`);
    }
  }
}

function main(): void {
  const dbPath = getDbPath();
  // Sweep BEFORE the early return: debris outlives the database it came from,
  // and on a fresh install it is the only thing on the volume.
  sweepStrayFiles(path.dirname(dbPath), dbPath);

  if (!fs.existsSync(dbPath)) {
    log.info("[prune:db] no database yet — nothing to prune");
    return;
  }

  const dir = path.dirname(dbPath);
  const before = fileSize(dbPath);
  const walBefore = fileSize(`${dbPath}-wal`);
  const free = freeBytes(dir);
  log.info(
    `[prune:db] base ${fmt(before)} + WAL ${fmt(walBefore)} · libre en disco ${free === null ? "desconocido" : fmt(free)}`,
  );

  // STEP 0 — emergency. Only when the disk is too full for SQL to work at all.
  const critical = free !== null && free < CRITICAL_FREE_BYTES;
  if (critical) {
    log.warn(`[prune:db] disco crítico (${fmt(free)} libre) — entrando en modo recuperación`);
    emergencyUnlink(dbPath);
  }

  const retention = critical ? RECOVERY_RETENTION : RETENTION;
  if (critical) log.warn(`[prune:db] retención agresiva activa (observed_trades ${retention.observedTrades}d)`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("busy_timeout = 30000");
  // Temp data goes to the volume, never to RAM. SQLite builds VACUUM's rebuild
  // and large sorts in "temp storage"; some builds default that to memory, and
  // a multi-GB rebuild held in RAM is exactly what OOM-killed this container on
  // 2026-08-04. Keep it on disk where its size is visible and bounded.
  try {
    sqlite.pragma(`temp_store = FILE`);
  } catch {
    /* best effort — the VACUUM gate below is the real protection */
  }

  // In recovery, a rollback journal per small transaction is cheaper than a WAL
  // that has to grow before it can shrink anything.
  if (critical) {
    try {
      sqlite.pragma("journal_mode = DELETE");
      log.info("[prune:db] journal_mode=DELETE mientras recuperamos espacio");
    } catch (err) {
      log.warn(`[prune:db] no se pudo cambiar journal_mode: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // STEP 1 — normal path: fold the WAL back in so it stops holding bytes.
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      const walAfter = fileSize(`${dbPath}-wal`);
      log.info(`[prune:db] WAL ${fmt(walBefore)} → ${fmt(walAfter)} (liberado ${fmt(walBefore - walAfter)})`);
    } catch (err) {
      log.warn(`[prune:db] no se pudo hacer checkpoint del WAL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const now = Date.now();
  const has = (table: string): boolean => {
    try {
      return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    } catch {
      return false;
    }
  };
  const weigh = (table: string, col: string): number => {
    if (!has(table)) return 0;
    try {
      const r = sqlite.prepare(`SELECT COALESCE(SUM(LENGTH(${col})),0) b FROM ${table}`).get() as { b: number };
      return r.b;
    } catch {
      return 0;
    }
  };

  /** Blank/update in one statement — these rewrite in place, so they are cheap. */
  const update = (label: string, table: string, sql: string, ...params: unknown[]): void => {
    if (!has(table)) return;
    try {
      const info = sqlite.prepare(sql).run(...(params as never[]));
      if (info.changes > 0) log.info(`[prune:db] ${label}: ${info.changes} filas`);
    } catch (err) {
      log.warn(`[prune:db] ${label} falló: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Chunked delete. A single DELETE of half a million rows needs a journal as
   * big as the pages it touches — exactly what a full disk cannot give. Small
   * batches keep each transaction's journal tiny, so this makes progress even
   * with almost no headroom. `LIMIT` inside a subquery because `DELETE ... LIMIT`
   * needs a compile-time flag better-sqlite3 does not ship.
   */
  const deleteOld = (label: string, table: string, tsCol: string, cutoff: number): number => {
    if (!has(table)) return 0;
    let total = 0;
    try {
      const stmt = sqlite.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${tsCol} < ? LIMIT ${DELETE_CHUNK})`,
      );
      for (;;) {
        const info = stmt.run(cutoff);
        total += info.changes;
        if (info.changes < DELETE_CHUNK) break;
      }
      if (total > 0) log.info(`[prune:db] ${label}: ${total} filas borradas`);
    } catch (err) {
      log.warn(`[prune:db] ${label} falló tras ${total} filas: ${err instanceof Error ? err.message : String(err)}`);
    }
    return total;
  };

  // STEP 2 — measure where the weight actually is, so the log tells the truth
  // instead of us guessing again next time.
  const weights: Array<[string, number]> = [
    ["observed_trades.raw_trade_json", weigh("observed_trades", "raw_trade_json")],
    ["market_snapshots.raw_market_json", weigh("market_snapshots", "raw_market_json")],
    ["decision_journal.reasons+risks", weigh("decision_journal", "reasons_json") + weigh("decision_journal", "risks_json")],
    ["leaderboard_scans.raw_summary_json", weigh("leaderboard_scans", "raw_summary_json")],
  ];
  weights.sort((a, b) => b[1] - a[1]);
  for (const [what, bytes] of weights) if (bytes > 0) log.info(`[prune:db] peso ${what}: ${fmt(bytes)}`);

  // STEP 3 — drop rows past the window anything reads. Done BEFORE the blanking
  // updates: deletes are what actually return pages, and on a tight disk the
  // cheap wins must land first. Paper trades are NOT here — the matrices and
  // every strategy verdict are built on them.
  deleteOld("observed_trades antiguos", "observed_trades", "created_at", now - retention.observedTrades * DAY);
  deleteOld("market_snapshots antiguos", "market_snapshots", "collected_at", now - retention.marketSnapshots * DAY);
  deleteOld("pnl_snapshots antiguos", "pnl_snapshots", "collected_at", now - retention.pnlSnapshots * DAY);

  // STEP 4 — blank raw payloads still inside the retention window. These are
  // verbatim API responses we already parsed into typed columns; nothing in the
  // app reads them back.
  update(
    "raw_trade_json vaciado",
    "observed_trades",
    `UPDATE observed_trades SET raw_trade_json='{}' WHERE created_at < ? AND LENGTH(raw_trade_json) > 2`,
    now - retention.rawTradeJson * DAY,
  );
  update(
    "raw_market_json vaciado",
    "market_snapshots",
    `UPDATE market_snapshots SET raw_market_json='{}' WHERE collected_at < ? AND LENGTH(raw_market_json) > 2`,
    now - retention.rawMarketJson * DAY,
  );
  update(
    "decision_journal texto vaciado",
    "decision_journal",
    `UPDATE decision_journal SET reasons_json='[]', risks_json='[]' WHERE created_at < ? AND (LENGTH(reasons_json) > 2 OR LENGTH(risks_json) > 2)`,
    now - retention.decisionJson * DAY,
  );
  update(
    "leaderboard_scans vaciado",
    "leaderboard_scans",
    `UPDATE leaderboard_scans SET raw_summary_json='{}' WHERE scanned_at < ? AND LENGTH(raw_summary_json) > 2`,
    now - retention.leaderboardScans * DAY,
  );

  // STEP 5 — reclaim, but only when it can actually succeed.
  //
  // DELETE leaves free pages inside the file; only VACUUM shrinks it on disk.
  // The catch is that VACUUM rebuilds the WHOLE database into a temporary copy,
  // so it needs free space about the size of the database itself. On 2026-08-04
  // this script ran VACUUM on a 5 GB database with the volume at 99% and the
  // rebuild OOM-killed the container at 8 GB — turning a recoverable disk
  // problem into a crash loop. Shrinking the file is a NICE-TO-HAVE: once rows
  // are deleted, SQLite reuses those free pages, so the database stops growing
  // and the app runs fine at its current size. Never risk the boot for it.
  try {
    const dbNow = fileSize(dbPath);
    const freeNow = freeBytes(dir);
    const needed = dbNow * VACUUM_HEADROOM_FACTOR;
    const freePages = Number((sqlite.pragma("freelist_count", { simple: true }) as number) ?? 0);
    const pageSize = Number((sqlite.pragma("page_size", { simple: true }) as number) ?? 4096);
    const slack = freePages * pageSize;
    const wantsVacuum = process.argv.includes("--force-vacuum") || slack >= VACUUM_THRESHOLD_BYTES;
    const hasRoom = freeNow !== null && freeNow >= needed;

    if (!wantsVacuum) {
      log.info(`[prune:db] solo ${fmt(slack)} en páginas libres — VACUUM no hace falta`);
    } else if (!hasRoom) {
      // The important branch: refuse loudly instead of trying and dying.
      log.warn(
        `[prune:db] VACUUM OMITIDO a propósito: necesita ~${fmt(needed)} libres y hay ` +
          `${freeNow === null ? "desconocido" : fmt(freeNow)}. Las ${fmt(slack)} en páginas libres se ` +
          `reutilizan igual, así que el archivo deja de crecer y la app arranca. Se compactará solo ` +
          `en un arranque futuro, cuando ya haya espacio.`,
      );
    } else {
      log.info(`[prune:db] compactando: ${fmt(slack)} en páginas libres, ${fmt(freeNow)} de disco disponible`);
      sqlite.exec("VACUUM");
      log.info("[prune:db] VACUUM ok — espacio devuelto al disco");
    }
  } catch (err) {
    log.warn(
      `[prune:db] VACUUM no pudo correr (${err instanceof Error ? err.message : String(err)}) — ` +
        `las páginas liberadas se reutilizan igual, el archivo deja de crecer`,
    );
  }

  // Restore the normal journal mode we run under (see db/client.ts).
  try {
    sqlite.pragma("journal_mode = WAL");
  } catch {
    /* the next process will set it anyway */
  }

  sqlite.close();
  const after = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
  const freeAfter = freeBytes(dir);
  log.info(
    `[prune:db] total ${fmt(before + walBefore)} → ${fmt(after)} · libre en disco ${
      freeAfter === null ? "desconocido" : fmt(freeAfter)
    }`,
  );
}

try {
  main();
} catch (err) {
  // Never block the boot: a failed prune must not keep the dashboard down.
  log.error(`[prune:db] falló: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
