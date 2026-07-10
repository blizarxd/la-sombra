import "../lib/env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@/lib/logger";

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
const statePath = path.join(projectRoot, "data", "operator-state.json");

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

  // --- Daily cycle: at most once per calendar day ---
  const state = readState();
  const today = todayKey();
  if (state.lastDailyRun !== today) {
    log.info("[operator:tick] running DAILY cycle (first tick of the day)");
    step("scan-wallets.ts", ["--limit", "25"]); // profile a fresh batch, gentle on the API
    step("update-rules.ts");
    step("report-daily.ts");
    writeState({ ...state, lastDailyRun: today });
  } else {
    log.info("[operator:tick] daily cycle already done today — frequent cycle only");
  }

  log.info("[operator:tick] === tick complete ===");
}

main();
