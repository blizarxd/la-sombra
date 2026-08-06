import "../lib/env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, isNotNull, isNull, like, lt, or } from "drizzle-orm";
import { getDb, getDbPath } from "../db/client";
import { walletProfiles } from "../db/schema";
import { APP_TZ, dayKeyTz, hourInAppTz } from "../lib/format";
import { log } from "../lib/logger";

/**
 * HEAVY lane of the operator: wallet sourcing, deep profiling, and the once-a-
 * day cut (rule tuners -> AI analyst -> EOD report).
 *
 * Split out of operator-tick.ts on 2026-07-16 after a real outage. The old
 * single-lane design put this work in the SAME process as monitor/score, which
 * shares a scheduler mutex with the 2-minute live tick (they both run
 * score-trades and would double-copy if overlapped). Once this heavy work ran
 * every tick, it held that mutex almost continuously and the live book went to
 * ZERO signals for a whole day — starved, not broken. Nothing here runs
 * monitor-trades or score-trades, so it can never double-score, which is
 * exactly why it is safe to give it its own lane and its own mutex.
 *
 * Read-only / paper-only, like every other script. No orders, ever.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..", "..");
const statePath = path.join(path.dirname(getDbPath()), "operator-state.json");

type State = {
  lastDailyRun?: string;
  lastCycleToken?: string;
  /** Step-level checkpoint so a killed cycle RESUMES instead of restarting. */
  dailyProgress?: { day: string; done: string[] };
};

// One-shot force token: bump this string in a deploy to force the DAILY cycle
// to run ONCE on the next tick, regardless of the 08:00 gate below.
const DAILY_CYCLE_TOKEN = "2026-08-04-volume-recovery";

// Johan's requested cut time: once a day, at 8am on HIS clock (APP_TZ).
const DAILY_CYCLE_HOUR = 8;

/**
 * The daily cut, in order. Each entry is checkpointed the moment it finishes,
 * so if the watchdog kills the process mid-cycle (or the container restarts),
 * the next tick picks up at the next unfinished step rather than re-running the
 * expensive scans from the top. That re-running is what broke 2026-07-16: every
 * retry re-mined wallets, which grew the profiling backlog to 2467, which kept
 * every lane permanently busy — a loop that fed itself.
 */
const DAILY_STEPS: Array<{ file: string; args?: string[] }> = [
  { file: "prune-db.ts" }, // 🧹 FIRST: keep the volume from filling (it hit 100% on 2026-08-04 and took the app down)
  { file: "scan-leaderboard.ts" }, // refresh the top-500 real-wallet queue (idempotent upsert)
  { file: "scan-crypto-markets.ts" }, // mine crypto-active wallets the PnL board hides
  { file: "scan-fast-markets.ts" }, // mine scalpers from fast-resolving markets
  { file: "scan-combo-leaderboard.ts" }, // 🧩 mine the Combo Cup board
  { file: "profile-combo-wallets.ts" }, // 🧩 combo cashflow scorecards (eligibility gate)
  { file: "scan-wallets.ts", args: ["--limit", "50"] }, // profile a fresh batch, gentle on the API
  // (update-elite-roster.ts retired 2026-07-18: La Crema is now matrix-gold-cell
  //  driven, not top-10-wallet driven — the roster no longer gates any entry.)
  { file: "manual-tune-2026-07-15.ts" }, // one-off, idempotent, self-skips once applied
  { file: "backfill-crema-rules.ts" }, // one-off, idempotent: label post-rebuild Crema copies
  { file: "derive-crema-cells.ts" }, // 🧬 re-derive La Crema's gold/trap cells (self-evolving, hysteresis-gated)
  { file: "update-rules.ts" }, // self-improve CORE on core evidence
  { file: "update-rules-live.ts" }, // self-improve LIVE on live evidence
  { file: "update-rules-trade.ts" }, // self-improve TRADE book
  { file: "update-rules-crypto.ts" }, // self-improve CRYPTO book
  { file: "resolve-daily-picks.ts" }, // 🎯 settle yesterday's pick BEFORE choosing today's
  { file: "select-daily-pick.ts" }, // 🎯 freeze ONE pick, before the outcome is known
  { file: "ai-analyst.ts" }, // 🧠 the cut: reasoning + bounded auto-tuning
  { file: "report-daily.ts" }, // EOD report (+ Telegram if configured)
];

/**
 * Should the daily cut run on this tick, and why? Pure so the gate that lost a
 * whole day's cut on 2026-07-16 is actually testable.
 *
 * `resuming` is the fix for that outage: a cut that started at 08:00 and got
 * killed mid-way used to be indistinguishable from one that never started, so
 * once the clock left the 08:00 hour the bot silently gave up until the next
 * morning — with the rule tuners, the AI cut and the report never having run.
 */
export function dailyCutDecision(
  state: State,
  today: string,
  hour: number,
  opts: { hasWalletQueue: boolean; token: string },
): { run: boolean; reason: string; doneToday: string[] } {
  const alreadyRanToday = state.lastDailyRun === today;
  const doneToday = state.dailyProgress?.day === today ? state.dailyProgress.done : [];
  if (alreadyRanToday) return { run: false, reason: "already ran today", doneToday: [] };
  if (state.lastCycleToken !== opts.token) return { run: true, reason: `forced by token ${opts.token}`, doneToday };
  if (doneToday.length > 0) return { run: true, reason: `resuming today's cut (${doneToday.length} steps already done)`, doneToday };
  if (!opts.hasWalletQueue) return { run: true, reason: "bootstrap: empty wallet queue", doneToday };
  if (hour === DAILY_CYCLE_HOUR) return { run: true, reason: `08:00 ${APP_TZ} cut`, doneToday };
  return { run: false, reason: `waiting for 08:00 ${APP_TZ} (now ${hour}:00)`, doneToday };
}

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
    return true; // never block on a read error
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
    return true;
  }
}

/** True while any market-mined wallet is still waiting to be profiled. */
function hasUnprofiledSourced(): boolean {
  try {
    const rows = getDb()
      .select({ id: walletProfiles.id })
      .from(walletProfiles)
      .where(and(isNotNull(walletProfiles.sources), isNull(walletProfiles.lastScannedAt)))
      .limit(1)
      .all();
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** True while ANY leaderboard-ranked wallet needs (re)profiling. */
function hasWalletNeedingProfile(): boolean {
  try {
    const staleBefore = new Date(Date.now() - 12 * 3600 * 1000);
    const rows = getDb()
      .select({ id: walletProfiles.id })
      .from(walletProfiles)
      .where(
        and(isNotNull(walletProfiles.sourceRank), or(isNull(walletProfiles.lastScannedAt), lt(walletProfiles.lastScannedAt, staleBefore))),
      )
      .limit(1)
      .all();
    return rows.length > 0;
  } catch {
    return false;
  }
}

function step(scriptFile: string, args: string[] = []): void {
  const full = path.join(scriptsDir, scriptFile);
  try {
    execFileSync(process.execPath, ["--import", "tsx", full, ...args], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } catch {
    // Sub-scripts log their own real errors. A failing step must not abort the
    // rest of the lane — but it IS still checkpointed, so a step that fails for
    // a real upstream reason doesn't wedge the cycle forever.
    log.warn(`[operator:daily] step ${scriptFile} exited non-zero — continuing`);
  }
}

async function main() {
  const now = new Date();
  log.info(`[operator:daily] === heavy lane @ ${now.toISOString()} (PAPER ONLY) ===`);

  // --- Sourcing top-up: keep each desk's wallet pool fed and drain the
  // profiling queue a modest batch at a time. Lives here (not in the fast lane)
  // because these are slow API-bound scans. ---
  const needCrypto = !hasSourceTag("crypto-market");
  const needFast = !hasSourceTag("fast-market");
  if (needCrypto || needFast) {
    log.info(`[operator:daily] sourcing bootstrap (crypto=${needCrypto}, fast=${needFast})`);
    if (needCrypto) step("scan-crypto-markets.ts");
    if (needFast) step("scan-fast-markets.ts");
  }
  if (needCrypto || needFast || hasUnprofiledSourced() || hasWalletNeedingProfile()) {
    step("scan-wallets.ts", ["--limit", "30"]);
  }

  // --- Daily cut: once per Caracas calendar day, at 08:00. Exceptions that
  // bypass the hour gate: bootstrap (fresh deploy, empty wallet queue), a
  // one-shot DAILY_CYCLE_TOKEN bump, and RESUMING a cycle that started today
  // but did not finish (added 2026-07-16 — without it, a cycle killed mid-way
  // during the 08:00 hour silently gave up until the next morning, which is
  // exactly how the bot lost a whole day's cut). ---
  const today = dayKeyTz(now);
  const decision = dailyCutDecision(readState(), today, hourInAppTz(now), {
    hasWalletQueue: hasWalletQueue(),
    token: DAILY_CYCLE_TOKEN,
  });

  if (!decision.run) {
    log.info(`[operator:daily] daily cut skipped — ${decision.reason} — sourcing only`);
    log.info("[operator:daily] === done ===");
    return;
  }

  log.info(`[operator:daily] running DAILY cut (${decision.reason})`);

  const done = new Set(decision.doneToday);
  for (const { file, args } of DAILY_STEPS) {
    if (done.has(file)) {
      log.info(`[operator:daily] skip ${file} — already done today`);
      continue;
    }
    step(file, args ?? []);
    done.add(file);
    // Persist after EVERY step: this is the whole point of the lane. A SIGKILL
    // now costs one in-flight step, not the entire cut.
    writeState({ ...readState(), dailyProgress: { day: today, done: [...done] } });
  }

  writeState({ ...readState(), lastDailyRun: today, lastCycleToken: DAILY_CYCLE_TOKEN, dailyProgress: undefined });
  log.info(`[operator:daily] daily cut COMPLETE for ${today}`);
  log.info("[operator:daily] === done ===");
}

// Only run when invoked as a script — tests import dailyCutDecision from here,
// and importing a module must never fire off the daily cut as a side effect.
const invokedDirectly = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main();
