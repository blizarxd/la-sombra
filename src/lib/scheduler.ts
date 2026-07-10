import "./env";
import { execFile } from "node:child_process";
import path from "node:path";
import { log } from "./logger";

/**
 * In-process operator scheduler for cloud (Railway) 24/7 running.
 *
 * On Railway a persistent volume mounts to a SINGLE service, so the web server
 * and the operator must live in the same process to share the SQLite file.
 * This runs the SAME `operator-tick` script as a child process on an interval
 * (never blocks the web event loop). It adds no new capability — still
 * read-only / paper-only. No orders, ever.
 *
 * Enabled only when OPERATOR_SCHEDULER=1 so local `npm run dev` stays quiet.
 */

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  const minutes = Number(process.env.OPERATOR_INTERVAL_MINUTES ?? 20);
  const intervalMs = Math.max(1, minutes) * 60_000;
  const script = path.join(process.cwd(), "src", "scripts", "operator-tick.ts");

  let running = false;
  const runTick = () => {
    if (running) {
      log.warn("[scheduler] previous tick still running — skipping this interval");
      return;
    }
    running = true;
    log.info("[scheduler] launching operator tick");
    execFile(
      process.execPath,
      ["--import", "tsx", script],
      { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        running = false;
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (err) log.warn(`[scheduler] tick exited non-zero: ${err.message}`);
        else log.info("[scheduler] tick finished");
      },
    );
  };

  // First run shortly after boot (let the web server settle), then on interval.
  setTimeout(runTick, 15_000);
  setInterval(runTick, intervalMs);
  log.info(`[scheduler] operator scheduler active — every ${minutes} min (PAPER ONLY)`);
}
