import "../lib/env";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../lib/logger";

/**
 * LIGHT "live tick" for the fast (e.g. 2-min) observation loop.
 *
 * Only monitors tracked wallets and scores what they just did — this is how we
 * CATCH and CLASSIFY in-play (live) bets in near real time for analysis. It is
 * NOT a live-copy engine: scoring still applies every rule (entry band, late-
 * entry drift guard, exposure guard), so a stale live price is correctly
 * skipped. Read-only / paper-only, no orders.
 */

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..", "..");

function step(scriptFile: string, args: string[] = []): void {
  try {
    execFileSync(process.execPath, ["--import", "tsx", path.join(scriptsDir, scriptFile), ...args], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } catch {
    log.warn(`[live-tick] step ${scriptFile} exited non-zero — continuing`);
  }
}

log.info("[live-tick] === live observation tick (PAPER ONLY) ===");
step("monitor-trades.ts");
step("score-trades.ts");
log.info("[live-tick] === done ===");
