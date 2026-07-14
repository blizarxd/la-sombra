import { and, eq, ne } from "drizzle-orm";
import { eliteRoster, paperTrades } from "@/db/schema";
import { ELITE_LOOKBACK_MS, rankEliteRoster } from "@/lib/elite";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * 🏆 Elite roster ("la crema") — refresh once a day (daily cycle).
 *
 * Per arm (core/live/trade/crypto), ranks wallets by REALIZED paper PnL over
 * the trailing 7 days and keeps only the top 10 confirmed winners (pnl > 0).
 * Wipes and rebuilds the roster each run — a wallet having a bad week simply
 * falls off, no special "least active" logic needed since this is a full
 * daily recompute, not an incremental swap.
 *
 * score-trades.ts reads this roster to decide whether to ALSO mirror a trade
 * an arm already opened into the elite ledger — this script only picks WHO,
 * never opens a position itself.
 */

const ARMS = ["core", "live", "trade", "crypto"] as const;

runScript("update:elite-roster", async (db) => {
  const now = new Date();
  const sinceMs = now.getTime() - ELITE_LOOKBACK_MS;

  let totalSlots = 0;
  for (const arm of ARMS) {
    const rows = db
      .select({
        walletAddress: paperTrades.walletAddress,
        realizedPnl: paperTrades.realizedPnl,
        resolvedAt: paperTrades.resolvedAt,
        closedAt: paperTrades.closedAt,
      })
      .from(paperTrades)
      .where(and(eq(paperTrades.track, arm), ne(paperTrades.status, "open")))
      .all();

    const perWallet = new Map<string, { pnl: number; n: number }>();
    for (const r of rows) {
      const settledMs = (r.resolvedAt ?? r.closedAt)?.getTime();
      if (!settledMs || settledMs < sinceMs) continue; // only this trailing week
      const cur = perWallet.get(r.walletAddress) ?? { pnl: 0, n: 0 };
      cur.pnl += r.realizedPnl ?? 0;
      cur.n += 1;
      perWallet.set(r.walletAddress, cur);
    }

    const ranked = rankEliteRoster(perWallet);

    db.delete(eliteRoster).where(eq(eliteRoster.arm, arm)).run();
    for (const entry of ranked) {
      db.insert(eliteRoster)
        .values({
          id: newId(),
          arm,
          walletAddress: entry.walletAddress,
          rank: entry.rank,
          weeklyPnl: entry.weeklyPnl,
          weeklyTradeCount: entry.weeklyTradeCount,
          computedAt: now,
        })
        .run();
    }
    log.info(
      `[update:elite-roster] ${arm}: ${ranked.length}/${perWallet.size} wallets qualify (7d realized pnl > 0)` +
        (ranked[0] ? ` — #1 ${ranked[0].walletAddress.slice(0, 10)}… $${ranked[0].weeklyPnl.toFixed(2)}` : ""),
    );
    totalSlots += ranked.length;
  }
  log.info(`[update:elite-roster] roster refreshed: ${totalSlots} wallet-slots across ${ARMS.length} arms`);
});
