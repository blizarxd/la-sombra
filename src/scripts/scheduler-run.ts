import "../lib/env";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../lib/logger";

/**
 * Standalone operator scheduler for cloud (Railway) 24/7 running.
 *
 * Runs as its OWN process (started in the background by `start:prod`), NOT via
 * Next.js instrumentation — that kept dragging server-only node: builtins into
 * the client bundle and broke `next dev`. As a plain tsx script it is never
 * seen by webpack.
 *
 * It fires the SAME read-only / paper-only `operator-tick` as a child process
 * on an interval. No new capability, no orders — ever.
 *
 * Gated by OPERATOR_SCHEDULER=1 so it stays off unless explicitly enabled.
 */

if (process.env.OPERATOR_SCHEDULER !== "1") {
  log.info("[scheduler] OPERATOR_SCHEDULER != 1 — scheduler disabled, exiting");
  process.exit(0);
}

const minutes = Number(process.env.OPERATOR_INTERVAL_MINUTES ?? 20);
const intervalMs = Math.max(1, minutes) * 60_000;
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..", "..");

// Optional fast live-observation loop: catch/classify in-play bets in near
// real time. Off unless LIVE_MONITOR=1 (it hits the wallet-trades API more
// often, so keep the interval sane).
const liveEnabled = process.env.LIVE_MONITOR === "1";
const liveMinutes = Math.max(1, Number(process.env.LIVE_MONITOR_MINUTES ?? 2));

// One shared mutex: never run two child passes at once (avoids double-scoring
// the same observed trades and keeps the API load bounded).
//
// WATCHDOG: a child pass gets a hard timeout. Without it, a single sub-script
// hanging on an upstream API call (no per-request timeout) would block the child
// forever, leave `busy` stuck true, and silently skip every future tick — the
// bot goes mute until a container restart. The timeout kills the hung child and
// frees the mutex so the next tick recovers on its own.
//
// A flat ceiling, NOT capped to the tick interval: the once-a-day DAILY cycle
// (embedded in the same operator-tick.ts invocation whenever its 08:00 gate
// fires) does real sequential work — leaderboard/crypto/fast/combo scans,
// combo profiling, a 50-wallet profiling batch, 4 rule tuners, one AI analyst
// API call, EOD report. Found 2026-07-15: once the combo scraper started
// actually succeeding (it used to fail in ~1s), the daily cycle grew past the
// old 15-minute cap and got SIGKILLed before reaching later steps (rule
// tuners, AI analyst, report) every single run — silently, since a killed
// run never persists `lastCycleToken`, so it just retried from the top next
// tick and hit the same wall. A longer ceiling only costs a few skipped
// FREQUENT ticks (mutex-guarded, logged, harmless) on the one day-per-day it
// runs long; it never blocks the bot from noticing a genuinely hung script.
const CHILD_TIMEOUT_MS = 25 * 60_000;
let busy = false;
function run(label: string, scriptFile: string): void {
  if (busy) {
    log.warn(`[scheduler] ${label} skipped — a pass is already running`);
    return;
  }
  busy = true;
  log.info(`[scheduler] launching ${label}`);
  execFile(
    process.execPath,
    ["--import", "tsx", path.join(scriptsDir, scriptFile)],
    { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
    (err, stdout, stderr) => {
      busy = false;
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err && (err as unknown as { killed?: boolean }).killed)
        log.error(`[scheduler] ${label} KILLED by watchdog after ${(CHILD_TIMEOUT_MS / 60000).toFixed(0)}m (hung) — mutex freed, next tick will retry`);
      else if (err) log.warn(`[scheduler] ${label} exited non-zero: ${err.message}`);
      else log.info(`[scheduler] ${label} finished`);
    },
  );
}

// The daily cut (rules self-improvement, AI analyst, elite roster, EOD
// report) fires from WITHIN operator-tick.ts's own 08:00 Johan's-clock gate —
// there used to be a SECOND, independent 8am timer here that called
// report-daily.ts on its own 5-minute poll, which could send the Telegram
// report twice on the same Caracas day (once from each mechanism, at
// slightly different moments). Removed 2026-07-14: one cut, one place.
log.info(
  `[scheduler] active — operator every ${minutes} min` +
    (liveEnabled ? `, live observation every ${liveMinutes} min` : "") +
    " (daily cut + report at 08:00 Johan's clock, PAPER ONLY)",
);
setTimeout(() => run("operator tick", "operator-tick.ts"), 15_000); // settle first
setInterval(() => run("operator tick", "operator-tick.ts"), intervalMs);
if (liveEnabled) {
  setInterval(() => run("live tick", "live-tick.ts"), liveMinutes * 60_000);
}
