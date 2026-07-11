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
    { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      busy = false;
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) log.warn(`[scheduler] ${label} exited non-zero: ${err.message}`);
      else log.info(`[scheduler] ${label} finished`);
    },
  );
}

log.info(
  `[scheduler] active — operator every ${minutes} min` +
    (liveEnabled ? `, live observation every ${liveMinutes} min` : "") +
    " (PAPER ONLY)",
);
setTimeout(() => run("operator tick", "operator-tick.ts"), 15_000); // settle first
setInterval(() => run("operator tick", "operator-tick.ts"), intervalMs);
if (liveEnabled) {
  setInterval(() => run("live tick", "live-tick.ts"), liveMinutes * 60_000);
}
