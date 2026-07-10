import { asc, eq, isNull, or, lt, and, isNotNull } from "drizzle-orm";
import { walletProfiles } from "@/db/schema";
import { fetchMarketsByConditionIds, fetchWalletTrades, isRealAddress } from "@/lib/adapters";
import type { MarketInfo } from "@/lib/adapters/types";
import { log } from "@/lib/logger";
import { profileWallet } from "@/lib/profiler";
import { getActiveRules } from "@/lib/rules";
import { argValue, runScript } from "./_runner";

/**
 * Steps 3-7 of the loop: deep-profile leaderboard wallets — 30d activity,
 * ROI, consistency, copyability, one-hit-wonder penalty, category strengths —
 * then set status track/watch/ignore with a written reason.
 *
 * Profiles a batch per run (default 15) to stay polite with the public APIs.
 */
runScript("scan:wallets", async (db) => {
  const batch = Number(argValue("--limit") ?? 15);
  const { rules } = getActiveRules(db);
  const staleBefore = new Date(Date.now() - 12 * 3600 * 1000);

  const candidates = db
    .select()
    .from(walletProfiles)
    .where(
      and(
        isNotNull(walletProfiles.sourceRank),
        or(isNull(walletProfiles.lastScannedAt), lt(walletProfiles.lastScannedAt, staleBefore)),
      ),
    )
    .orderBy(asc(walletProfiles.sourceRank))
    .limit(batch)
    .all();

  if (candidates.length === 0) {
    log.info("no wallets need profiling (all fresh) — run scan:leaderboard first if the DB is empty");
    return;
  }
  log.info(`profiling ${candidates.length} wallets (ranks ${candidates[0].sourceRank}..${candidates[candidates.length - 1].sourceRank})`);

  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  const marketCache = new Map<string, MarketInfo>();

  for (const wallet of candidates) {
    const now = new Date();
    if (!isRealAddress(wallet.address)) {
      log.warn(`skipping ${wallet.address} — not a real address (demo data is never profiled)`);
      db.update(walletProfiles).set({ lastScannedAt: now, updatedAt: now }).where(eq(walletProfiles.id, wallet.id)).run();
      continue;
    }
    try {
      const trades = await fetchWalletTrades(wallet.address, { limit: 500, sinceMs: thirtyDaysAgo });
      const conditionIds = [
        ...new Set(trades.map((t) => t.conditionId).filter((c): c is string => Boolean(c))),
      ].filter((c) => !marketCache.has(c));
      if (conditionIds.length > 0) {
        const markets = await fetchMarketsByConditionIds(conditionIds);
        for (const m of markets) if (m.conditionId) marketCache.set(m.conditionId, m);
      }
      const metrics = profileWallet(trades, marketCache, rules);
      const reason =
        metrics.status === "track"
          ? `global score ${Math.round(metrics.score.globalScore)} >= ${rules.minWalletGlobalScore}`
          : metrics.status === "watch"
            ? `global score ${Math.round(metrics.score.globalScore)} in watch band`
            : `global score ${Math.round(metrics.score.globalScore)} too low`;
      db.update(walletProfiles)
        .set({
          status: metrics.status,
          roi30d: metrics.roi30d,
          consistencyScore: metrics.score.consistencyScore,
          copyabilityScore: metrics.score.copyabilityScore,
          oneHitWonderPenalty: metrics.score.oneHitWonderPenalty,
          globalScore: metrics.score.globalScore,
          bestCategory: metrics.score.bestCategory,
          categoryStrengthsJson: JSON.stringify(metrics.score.categoryStrengths),
          averageTradeSize: metrics.averageTradeSize,
          tradeCount30d: metrics.tradeCount30d,
          resolvedTradeCount30d: metrics.resolvedTradeCount30d,
          winRate30d: metrics.winRate30d,
          averageLiquidity: metrics.averageLiquidity,
          copyabilityNotes: [reason, ...metrics.score.notes].join("; "),
          lastScannedAt: now,
          updatedAt: now,
        })
        .where(eq(walletProfiles.id, wallet.id))
        .run();
      log.info(
        `${wallet.address.slice(0, 10)}… -> ${metrics.status} (score ${Math.round(metrics.score.globalScore)}, ` +
          `${metrics.tradeCount30d} trades / ${metrics.resolvedTradeCount30d} resolved, ohw ${Math.round(metrics.score.oneHitWonderPenalty)})`,
      );
    } catch (err) {
      // Real error, real stop for this wallet — logged, never faked.
      log.error(`wallet ${wallet.address} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
});
