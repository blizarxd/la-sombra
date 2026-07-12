import { eq } from "drizzle-orm";
import { walletProfiles } from "@/db/schema";
import { fetchMarketsByTag, fetchMarketTrades, isRealAddress } from "@/lib/adapters";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { argValue, runScript } from "./_runner";

/**
 * Market-first wallet sourcing (the fix for the empty 🔁 Trade book + the seed
 * for crypto).
 *
 * The PnL leaderboard only surfaces HOLDERS (buy pre-game, hold to resolution).
 * Wallets that trade the odds — buy AND sell quickly — never show up there, so
 * the quota-scalper book had nothing to copy. This script mines wallets
 * directly from the busiest CRYPTO markets (Gamma tag_id=21), whose fast,
 * volatile nature breeds exactly those round-trip traders. Discovered wallets
 * are added to the profiling pool tagged "crypto-market"; scan:wallets then
 * measures their real swing behaviour and promotes the genuine ones.
 *
 * SAFETY: read-only discovery. No trades, no keys — just addresses to profile.
 */

const CRYPTO_TAG_ID = 21; // verified live 2026-07-12

runScript("scan:crypto-markets", async (db) => {
  const marketLimit = Number(argValue("--markets") ?? 20);
  const perMarket = Number(argValue("--per-market") ?? 100);
  const maxWallets = Number(argValue("--max-wallets") ?? 80);

  const markets = await fetchMarketsByTag(CRYPTO_TAG_ID, { limit: marketLimit });
  log.info(`crypto markets (tag ${CRYPTO_TAG_ID}): ${markets.length}`);
  if (markets.length === 0) {
    log.info("no active crypto markets returned — nothing to mine");
    return;
  }

  // Collect distinct wallets active in these markets (any side).
  const discovered = new Set<string>();
  for (const m of markets) {
    if (!m.conditionId) continue;
    try {
      const trades = await fetchMarketTrades(m.conditionId, { limit: perMarket });
      for (const t of trades) {
        if (isRealAddress(t.walletAddress)) discovered.add(t.walletAddress);
        if (discovered.size >= maxWallets) break;
      }
    } catch (err) {
      // A dead market feed is real info, not a reason to fake data — log & move on.
      log.warn(`market ${m.conditionId} trades failed: ${err instanceof Error ? err.message : err}`);
    }
    if (discovered.size >= maxWallets) break;
  }
  log.info(`discovered ${discovered.size} distinct wallets active in crypto markets`);

  const now = new Date();
  let created = 0;
  let tagged = 0;
  // Crypto-sourced wallets sit AFTER leaderboard ranks (1..500) in the profiling
  // queue but still get profiled; a high synthetic rank keeps them ordered last.
  let synthRank = 9000;
  for (const address of discovered) {
    const existing = db.select().from(walletProfiles).where(eq(walletProfiles.address, address)).get();
    if (existing) {
      const sources = mergeSource(existing.sources, "crypto-market");
      if (sources !== existing.sources) {
        db.update(walletProfiles).set({ sources, updatedAt: now }).where(eq(walletProfiles.id, existing.id)).run();
        tagged++;
      }
      continue;
    }
    db.insert(walletProfiles)
      .values({
        id: newId(),
        address,
        sourceRank: synthRank++,
        status: "watch",
        sources: "crypto-market",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    created++;
  }
  log.info(`crypto sourcing: ${created} new wallets queued, ${tagged} existing tagged crypto-market`);
});

/** Merge a discovery source into the comma-separated `sources` field (deduped). */
function mergeSource(current: string | null, add: string): string {
  const set = new Set((current ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  set.add(add);
  return [...set].join(",");
}
