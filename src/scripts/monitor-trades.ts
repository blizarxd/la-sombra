import { eq } from "drizzle-orm";
import { observedTrades, walletProfiles } from "@/db/schema";
import { fetchWalletTrades, isRealAddress } from "@/lib/adapters";
import { chunk, mapWithConcurrency } from "@/lib/concurrency";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * Step 8 of the loop: watch tracked wallets and record their NEW trades as
 * observed trades (deduped). Scoring happens separately in score:trades.
 *
 * Wallet fetches run CONCURRENTLY (bounded pool); DB writes stay sequential.
 * Until 2026-07-16 this was one sequential API call per tracked wallet. At ~300
 * wallets that was a couple of minutes; when the roster grew to ~1000 the pass
 * outran the 2-minute live tick it feeds, and the live book stopped seeing
 * in-play bets while games were still running. The fan-out is deliberately
 * modest — this is a research bot, not a scraper, and politeness to the upstream
 * API matters more than shaving the last second.
 */
const FETCH_CONCURRENCY = 6;
const CHUNK_SIZE = 60; // fetch a chunk, write it, move on — bounds memory

runScript("monitor:trades", async (db) => {
  const tracked = db.select().from(walletProfiles).where(eq(walletProfiles.status, "track")).all();
  if (tracked.length === 0) {
    log.info("no tracked wallets yet — run scan:leaderboard + scan:wallets first");
    return;
  }
  const real = tracked.filter((w) => {
    if (isRealAddress(w.address)) return true;
    log.warn(`skipping ${w.address} — not a real address (demo data is never monitored)`);
    return false;
  });
  log.info(`monitoring ${real.length} tracked wallets (${FETCH_CONCURRENCY} at a time)`);

  const defaultLookbackMs = 6 * 3600 * 1000; // first run: last 6h only
  let newCount = 0;

  for (const group of chunk(real, CHUNK_SIZE)) {
    const fetched = await mapWithConcurrency(group, FETCH_CONCURRENCY, async (wallet) => {
      const sinceMs = wallet.lastScannedAt
        ? Math.max(wallet.lastScannedAt.getTime() - 15 * 60 * 1000, Date.now() - 24 * 3600 * 1000)
        : Date.now() - defaultLookbackMs;
      try {
        return { wallet, trades: await fetchWalletTrades(wallet.address, { limit: 200, sinceMs }) };
      } catch (err) {
        // One wallet's API failure must not abandon the other 999. Real error,
        // logged, never papered over with fake trades.
        log.warn(`wallet trades unavailable for ${wallet.address}: ${err instanceof Error ? err.message : err}`);
        return { wallet, trades: null };
      }
    });

    for (const { wallet, trades } of fetched) {
      if (trades === null) continue; // fetch failed — leave lastScannedAt alone so we retry it
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
  }
  log.info(`observed ${newCount} new trades`);
});
