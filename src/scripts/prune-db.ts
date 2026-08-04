import "../lib/env";
import Database from "better-sqlite3";
import fs from "node:fs";
import { getDbPath } from "../db/client";
import { log } from "../lib/logger";

/**
 * 🧹 Disk-space guard — runs BEFORE anything else on boot.
 *
 * Written 2026-08-04 after the Railway volume hit 100% (5 GB) and took the
 * whole app down: SQLite could not write, so the service reported "Online"
 * while every request hung. The volume was not full of RESEARCH data — it was
 * full of RAW API PAYLOADS. Every observed trade stores the exchange's full
 * JSON (`raw_trade_json`), and the bot sees ~8,875 signals a day; the same is
 * true of market snapshots. Over a few weeks that is gigabytes of blobs we
 * already parsed into columns and never read again.
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

function main(): void {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    log.info("[prune:db] no database yet — nothing to prune");
    return;
  }

  const before = fileSize(dbPath);
  const walBefore = fileSize(`${dbPath}-wal`);
  log.info(`[prune:db] base ${fmt(before)} + WAL ${fmt(walBefore)} en ${dbPath}`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("busy_timeout = 30000");

  // STEP 1 — checkpoint the WAL. On a full volume this is the ONLY step that
  // frees bytes immediately, and it must happen before any DELETE (which would
  // otherwise need to grow the WAL it cannot grow).
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const walAfter = fileSize(`${dbPath}-wal`);
    log.info(`[prune:db] WAL ${fmt(walBefore)} → ${fmt(walAfter)} (liberado ${fmt(walBefore - walAfter)})`);
  } catch (err) {
    log.warn(`[prune:db] no se pudo hacer checkpoint del WAL: ${err instanceof Error ? err.message : String(err)}`);
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
  const run = (label: string, sql: string, ...params: unknown[]): number => {
    if (!has(sql.match(/(?:FROM|UPDATE)\s+(\w+)/i)?.[1] ?? "")) return 0;
    try {
      const info = sqlite.prepare(sql).run(...(params as never[]));
      if (info.changes > 0) log.info(`[prune:db] ${label}: ${info.changes} filas`);
      return info.changes;
    } catch (err) {
      log.warn(`[prune:db] ${label} falló: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
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

  // STEP 3 — blank raw payloads. These are verbatim API responses we already
  // parsed into typed columns; nothing in the app reads them back.
  run(
    "raw_trade_json vaciado",
    `UPDATE observed_trades SET raw_trade_json='{}' WHERE created_at < ? AND LENGTH(raw_trade_json) > 2`,
    now - RETENTION.rawTradeJson * DAY,
  );
  run(
    "raw_market_json vaciado",
    `UPDATE market_snapshots SET raw_market_json='{}' WHERE collected_at < ? AND LENGTH(raw_market_json) > 2`,
    now - RETENTION.rawMarketJson * DAY,
  );
  run(
    "decision_journal texto vaciado",
    `UPDATE decision_journal SET reasons_json='[]', risks_json='[]' WHERE created_at < ? AND (LENGTH(reasons_json) > 2 OR LENGTH(risks_json) > 2)`,
    now - RETENTION.decisionJson * DAY,
  );
  run(
    "leaderboard_scans vaciado",
    `UPDATE leaderboard_scans SET raw_summary_json='{}' WHERE scanned_at < ? AND LENGTH(raw_summary_json) > 2`,
    now - RETENTION.leaderboardScans * DAY,
  );

  // STEP 4 — drop rows past the window anything reads. Paper trades are NOT
  // here: the matrices and every strategy verdict are built on them.
  run("observed_trades antiguos", `DELETE FROM observed_trades WHERE created_at < ?`, now - RETENTION.observedTrades * DAY);
  run("market_snapshots antiguos", `DELETE FROM market_snapshots WHERE collected_at < ?`, now - RETENTION.marketSnapshots * DAY);
  run("pnl_snapshots antiguos", `DELETE FROM pnl_snapshots WHERE collected_at < ?`, now - RETENTION.pnlSnapshots * DAY);

  // STEP 5 — reclaim. DELETE leaves free pages inside the file; only VACUUM
  // shrinks it on disk. VACUUM rewrites the whole database and holds a write
  // lock the entire time, so it only earns its cost when there is real slack
  // to give back — otherwise the daily run would stall every other lane for
  // minutes to reclaim nothing.
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const freePages = Number((sqlite.pragma("freelist_count", { simple: true }) as number) ?? 0);
    const pageSize = Number((sqlite.pragma("page_size", { simple: true }) as number) ?? 4096);
    const slack = freePages * pageSize;
    // --force-vacuum is what boot uses: after the volume has actually filled,
    // reclaiming every byte matters more than the lock we hold to do it.
    const forced = process.argv.includes("--force-vacuum");
    if (forced || slack >= VACUUM_THRESHOLD_BYTES) {
      log.info(
        forced
          ? `[prune:db] VACUUM forzado (arranque) — ${fmt(slack)} en páginas libres`
          : `[prune:db] ${fmt(slack)} en páginas libres — corriendo VACUUM`,
      );
      // VACUUM needs scratch space roughly the size of the result, so on a
      // genuinely full volume it can fail. That is survivable — the freed
      // pages are reused, so the file stops growing — and must be reported
      // honestly rather than swallowed.
      sqlite.exec("VACUUM");
      log.info("[prune:db] VACUUM ok — espacio devuelto al disco");
    } else {
      log.info(`[prune:db] solo ${fmt(slack)} en páginas libres — VACUUM no hace falta`);
    }
  } catch (err) {
    log.warn(
      `[prune:db] VACUUM no pudo correr (${err instanceof Error ? err.message : String(err)}) — ` +
        `las páginas liberadas se reutilizan igual, el archivo deja de crecer`,
    );
  }

  sqlite.close();
  const after = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
  const freed = before + walBefore - after;
  log.info(`[prune:db] total ${fmt(before + walBefore)} → ${fmt(after)} · liberado ${fmt(freed)}`);
}

try {
  main();
} catch (err) {
  // Never block the boot: a failed prune must not keep the dashboard down.
  log.error(`[prune:db] falló: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
