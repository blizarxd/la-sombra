import "../lib/env";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_TZ } from "../lib/format";
import { log } from "../lib/logger";

/** Current {hour, dayKey} in the project timezone (UTC-4), server-TZ-independent. */
function nowInAppTz(): { hour: number; dayKey: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    hour: Number(get("hour")),
    dayKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

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
// frees the mutex so the next tick recovers on its own. Kept under the interval.
const CHILD_TIMEOUT_MS = Math.min(15 * 60_000, Math.max(60_000, intervalMs - 60_000));
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

// Morning summary: send the daily report to Telegram once per day at a fixed
// hour in the project timezone (UTC-4) — independent of the container's TZ.
const morningHour = Number(process.env.MORNING_REPORT_HOUR ?? 8);
let lastMorningKey = "";
function maybeMorningReport(): void {
  const { hour, dayKey } = nowInAppTz();
  if (hour === morningHour && lastMorningKey !== dayKey) {
    lastMorningKey = dayKey;
    log.info(`[scheduler] 🌅 morning summary (${morningHour}:00 ${APP_TZ}) — sending report`);
    run("morning report", "report-daily.ts");
  }
}

log.info(
  `[scheduler] active — operator every ${minutes} min` +
    (liveEnabled ? `, live observation every ${liveMinutes} min` : "") +
    `, morning report at ${morningHour}:00 ${APP_TZ} (PAPER ONLY)`,
);
setTimeout(() => run("operator tick", "operator-tick.ts"), 15_000); // settle first
setInterval(() => run("operator tick", "operator-tick.ts"), intervalMs);
if (liveEnabled) {
  setInterval(() => run("live tick", "live-tick.ts"), liveMinutes * 60_000);
}
setInterval(maybeMorningReport, 5 * 60_000); // check every 5 min, fires once/day
