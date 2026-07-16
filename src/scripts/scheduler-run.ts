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

// TWO LANES, TWO MUTEXES (rebuilt 2026-07-16 after a real outage).
//
// FAST lane — operator-tick (every `minutes`) and live-tick (every 2 min).
// These two MUST share a mutex: both run monitor-trades + score-trades, and
// overlapping them would double-copy the same observed trade. The lane is kept
// short so the live tick actually gets its turn.
//
// HEAVY lane — operator-daily: API-bound scans, wallet profiling, rule tuners,
// AI analyst, EOD report. It never runs monitor-trades or score-trades, so it
// CANNOT double-score, which is what makes a separate mutex safe. It writes to
// the same SQLite file concurrently — that is fine under WAL, and client.ts
// sets a busy_timeout so a write race waits instead of throwing.
//
// Why this exists: until 2026-07-16 all of it was ONE lane on ONE mutex. Once
// the heavy work started running every tick, it held the mutex almost
// continuously, the 2-minute live tick was skipped essentially forever, and the
// live book logged ZERO signals for a whole day. Splitting the lanes is the fix;
// the timeouts below are only a backstop for a genuinely hung script.
//
// WATCHDOG: each lane gets its own hard timeout. Without one, a sub-script
// hanging on an upstream API call would block its child forever, leave `busy`
// stuck true, and silently skip every future tick until a container restart.
// The fast lane's ceiling is tight because it has no excuse to run long. The
// heavy lane's is generous because it legitimately does — and, since
// operator-daily now checkpoints every step, a kill there costs one step, not
// the whole cut.
const FAST_TIMEOUT_MS = 10 * 60_000;
const HEAVY_TIMEOUT_MS = 40 * 60_000;

const busy: Record<"fast" | "heavy", boolean> = { fast: false, heavy: false };

function run(lane: "fast" | "heavy", label: string, scriptFile: string): void {
  if (busy[lane]) {
    log.warn(`[scheduler] ${label} skipped — the ${lane} lane is already running`);
    return;
  }
  busy[lane] = true;
  const timeout = lane === "fast" ? FAST_TIMEOUT_MS : HEAVY_TIMEOUT_MS;
  log.info(`[scheduler] launching ${label} (${lane} lane)`);
  execFile(
    process.execPath,
    ["--import", "tsx", path.join(scriptsDir, scriptFile)],
    { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024, timeout, killSignal: "SIGKILL" },
    (err, stdout, stderr) => {
      busy[lane] = false;
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err && (err as unknown as { killed?: boolean }).killed)
        log.error(`[scheduler] ${label} KILLED by watchdog after ${(timeout / 60000).toFixed(0)}m (hung) — ${lane} mutex freed, next tick will retry`);
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
  `[scheduler] active — fast lane every ${minutes} min, heavy lane every ${minutes} min` +
    (liveEnabled ? `, live observation every ${liveMinutes} min` : "") +
    " (daily cut + report at 08:00 Johan's clock, PAPER ONLY)",
);
setTimeout(() => run("fast", "operator tick", "operator-tick.ts"), 15_000); // settle first
setTimeout(() => run("heavy", "operator daily", "operator-daily.ts"), 45_000); // stagger off the fast lane
setInterval(() => run("fast", "operator tick", "operator-tick.ts"), intervalMs);
setInterval(() => run("heavy", "operator daily", "operator-daily.ts"), intervalMs);
if (liveEnabled) {
  setInterval(() => run("fast", "live tick", "live-tick.ts"), liveMinutes * 60_000);
}
