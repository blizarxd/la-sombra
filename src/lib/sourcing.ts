import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { walletProfiles } from "@/db/schema";
import { fetchMarketTrades, isRealAddress } from "@/lib/adapters";
import type { MarketInfo, WalletTrade } from "@/lib/adapters/types";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";

/**
 * Market-first wallet sourcing (shared by the crypto and fast-market miners).
 *
 * The PnL leaderboard only surfaces HOLDERS. To find wallets that trade the
 * odds we mine busy markets directly and profile whoever is active there.
 *
 * SAFETY: read-only discovery. No trades, no keys — just addresses to profile.
 */

/** Merge a discovery source into the comma-separated `sources` field (deduped). */
export function mergeSource(current: string | null, add: string): string {
  const set = new Set((current ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  set.add(add);
  return [...set].join(",");
}

/**
 * Pure selection: which wallets from a market's trade feed to source. When
 * `sellersOnly` is set we keep only wallets seen SELLING — a strong signal of a
 * round-tripper (scalper), which is exactly who the Trade book wants.
 */
export function selectSourcableWallets(
  trades: WalletTrade[],
  opts?: { sellersOnly?: boolean },
): string[] {
  const keep = new Set<string>();
  for (const t of trades) {
    if (!isRealAddress(t.walletAddress)) continue;
    if (opts?.sellersOnly && t.side !== "SELL") continue;
    keep.add(t.walletAddress);
  }
  return [...keep];
}

/** How near the synthetic-rank floor a source lands (keeps them ordered last). */
const SYNTH_RANK_BASE: Record<string, number> = {
  "crypto-market": 9000,
  "fast-market": 9500,
};

/**
 * Mine a set of markets: pull each one's trade feed, collect active wallets and
 * upsert them into the profiling pool tagged with `sourceTag`. Returns counts.
 */
export async function mineWalletsFromMarkets(
  db: Db,
  markets: MarketInfo[],
  sourceTag: string,
  opts?: { perMarket?: number; maxWallets?: number; sellersOnly?: boolean },
): Promise<{ discovered: number; created: number; tagged: number }> {
  const perMarket = opts?.perMarket ?? 100;
  const maxWallets = opts?.maxWallets ?? 80;

  const discovered = new Set<string>();
  for (const m of markets) {
    if (!m.conditionId) continue;
    try {
      const trades = await fetchMarketTrades(m.conditionId, { limit: perMarket });
      for (const address of selectSourcableWallets(trades, { sellersOnly: opts?.sellersOnly })) {
        discovered.add(address);
        if (discovered.size >= maxWallets) break;
      }
    } catch (err) {
      // A dead market feed is real info, not a reason to fake data — log & move on.
      log.warn(`market ${m.conditionId} trades failed: ${err instanceof Error ? err.message : err}`);
    }
    if (discovered.size >= maxWallets) break;
  }
  log.info(`discovered ${discovered.size} distinct wallets (${sourceTag})`);

  const now = new Date();
  let created = 0;
  let tagged = 0;
  let synthRank = SYNTH_RANK_BASE[sourceTag] ?? 9800;
  for (const address of discovered) {
    const existing = db.select().from(walletProfiles).where(eq(walletProfiles.address, address)).get();
    if (existing) {
      const sources = mergeSource(existing.sources, sourceTag);
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
        sources: sourceTag,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    created++;
  }
  return { discovered: discovered.size, created, tagged };
}
