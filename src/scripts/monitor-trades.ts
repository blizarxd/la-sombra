import { eq } from "drizzle-orm";
import { observedTrades, walletProfiles } from "@/db/schema";
import { fetchWalletTrades, isRealAddress } from "@/lib/adapters";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * Step 8 of the loop: watch tracked wallets and record their NEW trades as
 * observed trades (deduped). Scoring happens separately in score:trades.
 */
runScript("monitor:trades", async (db) => {
  const tracked = db.select().from(walletProfiles).where(eq(walletProfiles.status, "track")).all();
  if (tracked.length === 0) {
    log.info("no tracked wallets yet — run scan:leaderboard + scan:wallets first");
    return;
  }
  log.info(`monitoring ${tracked.length} tracked wallets`);

  const defaultLookbackMs = 6 * 3600 * 1000; // first run: last 6h only
  let newCount = 0;

  for (const wallet of tracked) {
    if (!isRealAddress(wallet.address)) {
      log.warn(`skipping ${wallet.address} — not a real address (demo data is never monitored)`);
      continue;
    }
    const sinceMs = wallet.lastScannedAt
      ? Math.max(wallet.lastScannedAt.getTime() - 15 * 60 * 1000, Date.now() - 24 * 3600 * 1000)
      : Date.now() - defaultLookbackMs;
    const trades = await fetchWalletTrades(wallet.address, { limit: 200, sinceMs });
    const now = new Date();
    for (const t of trades) {
      const dedupeKey =
        t.transactionHash ??
        `${t.walletAddress}|${t.marketId}|${t.side}|${t.price}|${t.sizeUsd.toFixed(2)}|${t.timestampMs}`;
      const exists = db
        .select({ id: observedTrades.id })
        .from(observedTrades)
        .where(eq(observedTrades.dedupeKey, dedupeKey))
        .get();
      if (exists) continue;
      db.insert(observedTrades)
        .values({
          id: newId(),
          walletAddress: t.walletAddress,
          marketId: t.marketId,
          conditionId: t.conditionId,
          tokenId: t.tokenId,
          marketQuestion: t.marketQuestion,
          marketCategory: t.marketCategory,
          outcome: t.outcome,
          side: t.side,
          walletEntryPrice: t.price,
          detectedPrice: null, // filled in by score:trades from the live book
          size: t.sizeUsd,
          timestamp: new Date(t.timestampMs),
          dedupeKey,
          scored: false,
          rawTradeJson: JSON.stringify(t.raw),
          createdAt: now,
        })
        .run();
      newCount++;
    }
    db.update(walletProfiles).set({ lastScannedAt: now, updatedAt: now }).where(eq(walletProfiles.id, wallet.id)).run();
  }
  log.info(`observed ${newCount} new trades`);
});
