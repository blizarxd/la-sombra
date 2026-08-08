import "../lib/env";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../lib/logger";

/**
 * FAST lane of the operator: catch fresh signals and keep PnL current.
 *
 * This lane must stay SHORT. It shares the scheduler's fast mutex with the
 * 2-minute live tick, because both run monitor-trades + score-trades and would
 * double-copy the same observed trades if they overlapped. Every minute this
 * lane holds that mutex is a minute the live book is blind.
 *
 * That is not hypothetical: on 2026-07-16 the heavy sourcing/profiling/daily
 * work still lived here, the lane ran for tens of minutes at a time, and the
 * live book recorded ZERO signals for a full day. All of it now lives in
 * operator-daily.ts. Keep it that way — if a step here is API-bound and slow,
 * it belongs in the heavy lane.
 *
 * Read-only / paper-only. No orders, ever.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..", "..");

function step(scriptFile: string, args: string[] = []): void {
  const full = path.join(scriptsDir, scriptFile);
  try {
    // Same Node + tsx loader (avoids .cmd spawn issues on Windows, needs no global tsx).
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
  const now = new Date();
  log.info(`[operator:tick] === fast tick @ ${now.toISOString()} (PAPER ONLY) ===`);

  step("enforce-core-policy.ts"); // idempotent human policy (max resolution window)
  step("monitor-trades.ts");
  step("score-trades.ts");
  step("paper-update-pnl.ts");
  step("combo-tick.ts"); // 🧩 combo book: copy + settle (own ledger, own settlement)
  step("review-outcomes.ts");
  // 🎯 Settle published picks here, not only on the daily cut. A game that ends
  // at 22:00 was sitting unresolved on the public record until the next morning,
  // which makes the scoreboard look stale exactly when someone checks it. Cheap:
  // one market lookup, and only while picks are actually open.
  step("resolve-daily-picks.ts");

  log.info("[operator:tick] === tick complete ===");
}

main();
