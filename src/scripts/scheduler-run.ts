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
const tickScript = path.join(scriptsDir, "operator-tick.ts");

let running = false;
function runTick(): void {
  if (running) {
    log.warn("[scheduler] previous tick still running — skipping this interval");
    return;
  }
  running = true;
  log.info("[scheduler] launching operator tick");
  execFile(
    process.execPath,
    ["--import", "tsx", tickScript],
    { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      running = false;
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) log.warn(`[scheduler] tick exited non-zero: ${err.message}`);
      else log.info("[scheduler] tick finished");
    },
  );
}

log.info(`[scheduler] operator scheduler active — every ${minutes} min (PAPER ONLY)`);
setTimeout(runTick, 15_000); // let the web server settle first
setInterval(runTick, intervalMs);
