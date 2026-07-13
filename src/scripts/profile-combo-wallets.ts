import { and, eq, isNull, like, lt, or } from "drizzle-orm";
import { walletProfiles } from "@/db/schema";
import { fetchWalletActivity, isRealAddress } from "@/lib/adapters";
import { computeComboWalletStats } from "@/lib/combos";
import { log } from "@/lib/logger";
import { argValue, runScript } from "./_runner";

/**
 * 🧩 Combo profiling: for wallets sourced off the Combo Cup board, read their
 * public activity feed and compute a cashflow-honest combo scorecard (stakes
 * in vs. redeems + cash-outs back, 30d). This is the eligibility gate that
 * separates "got lucky once on the board" from "consistently milks combos".
 *
 * SAFETY: read-only research. No trades, no keys.
 */

const LOOKBACK_MS = 30 * 24 * 3600 * 1000;
const REFRESH_AFTER_MS = 20 * 3600 * 1000; // ~daily, tolerant of cycle drift

runScript("profile:combo-wallets", async (db) => {
  const limit = Number(argValue("--limit") ?? 40);
  const now = new Date();
  const stale = new Date(now.getTime() - REFRESH_AFTER_MS);

  const pending = db
    .select()
    .from(walletProfiles)
    .where(
      and(
        like(walletProfiles.sources, "%combo-cup%"),
        or(isNull(walletProfiles.comboLastProfiledAt), lt(walletProfiles.comboLastProfiledAt, stale)),
      ),
    )
    .limit(limit)
    .all();
  if (pending.length === 0) {
    log.info("no combo wallets need profiling");
    return;
  }
  log.info(`combo-profiling ${pending.length} wallets`);

  let done = 0;
  for (const w of pending) {
    if (!isRealAddress(w.address)) continue;
    try {
      const events = await fetchWalletActivity(w.address, {
        limit: 300,
        sinceMs: now.getTime() - LOOKBACK_MS,
      });
      const stats = computeComboWalletStats(events, now.getTime(), LOOKBACK_MS);
      db.update(walletProfiles)
        .set({
          comboTradeCount30d: stats.buys,
          comboRedeemCount30d: stats.redeems,
          comboNetPnl30d: stats.netPnl,
          comboWinRate30d: stats.estWinRate,
          comboLastProfiledAt: now,
          updatedAt: now,
        })
        .where(eq(walletProfiles.id, w.id))
        .run();
      done++;
    } catch (err) {
      // Real API failures are logged, never papered over with fake stats.
      log.warn(`combo profile failed for ${w.address.slice(0, 10)}…: ${err instanceof Error ? err.message : err}`);
    }
  }
  log.info(`combo profiles updated: ${done}/${pending.length}`);
});
