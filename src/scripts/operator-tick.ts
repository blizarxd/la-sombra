import "../lib/env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNotNull, like } from "drizzle-orm";
import { getDb, getDbPath } from "../db/client";
import { walletProfiles } from "../db/schema";
import { log } from "../lib/logger";

/**
 * Single "operator tick" for scheduler / `/loop` use.
 *
 * Runs the FREQUENT cycle every time (monitor -> score -> update PnL ->
 * review outcomes), and the DAILY cycle at most once per calendar day
 * (a batch of wallet profiling -> auto rule update -> EOD report).
 *
 * Cadence state is kept in data/operator-state.json so restarts are safe.
 * Every sub-step is the SAME read-only / paper-only script used manually —
 * this orchestrator adds no new capability, only timing. No orders, ever.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..", "..");
// Keep cadence state NEXT TO THE DATABASE (the persistent volume in the
// cloud) so a redeploy does not re-trigger the daily cycle.
const statePath = path.join(path.dirname(getDbPath()), "operator-state.json");

type State = { lastDailyRun?: string };

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(s: State): void {
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** True once at least one real (leaderboard-sourced) wallet is queued. */
function hasWalletQueue(): boolean {
  try {
    const rows = getDb()
      .select({ id: walletProfiles.id })
      .from(walletProfiles)
      .where(isNotNull(walletProfiles.sourceRank))
      .limit(1)
      .all();
    return rows.length > 0;
  } catch {
    return true; // never block the tick on a read error
  }
}

/** True once at least one wallet carries the given source tag. */
function hasSourceTag(tag: string): boolean {
  try {
    const rows = getDb()
      .select({ id: walletProfiles.id })
      .from(walletProfiles)
      .where(like(walletProfiles.sources, `%${tag}%`))
      .limit(1)
      .all();
    return rows.length > 0;
  } catch {
    return true; // never block the tick on a read error
  }
}

function step(scriptFile: string, args: string[] = []): void {
  const full = path.join(scriptsDir, scriptFile);
  try {
    // Run each sub-script with the same Node + tsx loader (avoids .cmd spawn
    // issues on Windows and needs no global tsx).
    execFileSync(process.execPath, ["--import", "tsx", full, ...args], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } catch {
    // Sub-scripts already log their own real errors and set exit codes.
    // A failing step must not abort the rest of the tick.
    log.warn(`[operator:tick] step ${scriptFile} exited non-zero — continuing`);
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  log.info(`[operator:tick] === tick @ ${startedAt} (PAPER ONLY) ===`);

  // --- Frequent cycle: catch fresh signals and keep PnL current ---
  step("monitor-trades.ts");
  step("score-trades.ts");
  step("paper-update-pnl.ts");
  step("review-outcomes.ts");

  // Sourcing bootstrap: seed each desk's wallet pool from market mining without
  // waiting for the daily cycle. Checked PER TAG so a transient failure of one
  // miner (e.g. a rate-limited API call) is retried on the next tick instead of
  // being permanently skipped once the other tag succeeded.
  const needCrypto = !hasSourceTag("crypto-market");
  const needFast = !hasSourceTag("fast-market");
  if (needCrypto || needFast) {
    log.info(`[operator:tick] sourcing bootstrap (crypto=${needCrypto}, fast=${needFast})`);
    if (needCrypto) step("scan-crypto-markets.ts");
    if (needFast) step("scan-fast-markets.ts");
    step("scan-wallets.ts", ["--limit", "30"]); // profile a batch (reaches sourced wallets)
  }

  // --- Daily cycle: once per calendar day, or immediately if the real-wallet
  // queue is still empty (self-heals a fresh deploy without waiting a day). ---
  const state = readState();
  const today = todayKey();
  const firstOfDay = state.lastDailyRun !== today;
  const bootstrap = !hasWalletQueue();
  if (firstOfDay || bootstrap) {
    log.info(
      `[operator:tick] running DAILY cycle (${firstOfDay ? "first tick of the day" : "bootstrap: empty wallet queue"})`,
    );
    step("scan-leaderboard.ts"); // refresh the top-500 real-wallet queue (idempotent upsert)
    step("scan-crypto-markets.ts"); // mine crypto-active wallets the PnL board hides
    step("scan-fast-markets.ts"); // mine scalpers from fast-resolving markets (any category)
    step("scan-wallets.ts", ["--limit", "50"]); // profile a fresh batch, still gentle on the API
    step("update-rules.ts"); // self-improve CORE strategy on core evidence
    step("update-rules-live.ts"); // self-improve LIVE experiment on live evidence (own pace)
    step("update-rules-trade.ts"); // self-improve TRADE book (quota-scalpers) on its own evidence
    step("ai-analyst.ts"); // expert AI layer: reasoning + recommendations + bounded auto-tuning
    step("report-daily.ts");
    writeState({ ...state, lastDailyRun: today });
  } else {
    log.info("[operator:tick] daily cycle already done today — frequent cycle only");
  }

  log.info("[operator:tick] === tick complete ===");
}

main();
