import { gte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { observedTrades } from "@/db/schema";

/**
 * 🔗 Confluencia — the signal already sitting in the data, never asked for.
 *
 * When two or more DIFFERENT tracked wallets buy the same outcome of the same
 * market inside a short window, that is independent confirmation, and in copy
 * trading it is about the strongest single tell there is: it does not depend on
 * trusting any one wallet's judgement.
 *
 * Everything needed is already in `observed_trades` (market, outcome, wallet,
 * timestamp). No new collection, no new API call — it was simply never counted.
 *
 * Deliberate strictness:
 *   · DISTINCT wallets only. One wallet slicing an order into eight fills is
 *     one opinion, not eight, and counting fills would make our loudest wallet
 *     look like a crowd.
 *   · Same OUTCOME, not just same market: two wallets on opposite sides of a
 *     game are disagreement, and would otherwise read as agreement.
 *
 * Pure functions + one read-only query.
 */

export const CONFLUENCE_WINDOW_MS = 30 * 60 * 1000;

export type ConfluenceTrade = {
  id: string;
  walletAddress: string;
  marketId: string;
  outcome: string | null;
  side: string;
  timestamp: Date | number;
};

const ms = (d: Date | number): number => (d instanceof Date ? d.getTime() : d);

/** Market + outcome, the unit two wallets must agree on. */
export function positionKey(t: { marketId: string; outcome: string | null }): string {
  return `${t.marketId}::${(t.outcome ?? "?").toLowerCase()}`;
}

/**
 * For each trade: how many DISTINCT other tracked wallets bought the same
 * position within `windowMs` BEFORE it (a confirmation has to already exist to
 * count — looking forward would be reading the future at decision time).
 */
export function confluenceIndex(
  trades: ConfluenceTrade[],
  windowMs = CONFLUENCE_WINDOW_MS,
): Map<string, number> {
  const byPosition = new Map<string, ConfluenceTrade[]>();
  for (const t of trades) {
    if (t.side !== "BUY") continue;
    const k = positionKey(t);
    const arr = byPosition.get(k) ?? [];
    arr.push(t);
    byPosition.set(k, arr);
  }

  const out = new Map<string, number>();
  for (const arr of byPosition.values()) {
    arr.sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      const cutoff = ms(t.timestamp) - windowMs;
      const others = new Set<string>();
      for (let j = i - 1; j >= 0; j--) {
        if (ms(arr[j].timestamp) < cutoff) break;
        if (arr[j].walletAddress !== t.walletAddress) others.add(arr[j].walletAddress);
      }
      out.set(t.id, others.size);
    }
  }
  return out;
}

export type ConfluenceCluster = {
  marketId: string;
  outcome: string | null;
  wallets: string[];
  firstAt: number;
  lastAt: number;
};

/** Positions where 2+ distinct wallets agreed inside the window, newest first. */
export function findClusters(
  trades: ConfluenceTrade[],
  windowMs = CONFLUENCE_WINDOW_MS,
  minWallets = 2,
): ConfluenceCluster[] {
  const byPosition = new Map<string, ConfluenceTrade[]>();
  for (const t of trades) {
    if (t.side !== "BUY") continue;
    const arr = byPosition.get(positionKey(t)) ?? [];
    arr.push(t);
    byPosition.set(positionKey(t), arr);
  }

  const clusters: ConfluenceCluster[] = [];
  for (const arr of byPosition.values()) {
    arr.sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
    let start = 0;
    for (let i = 0; i < arr.length; i++) {
      while (ms(arr[i].timestamp) - ms(arr[start].timestamp) > windowMs) start++;
      const slice = arr.slice(start, i + 1);
      const wallets = [...new Set(slice.map((t) => t.walletAddress))];
      if (wallets.length < minWallets) continue;
      const last = clusters[clusters.length - 1];
      // Extend the cluster we are already inside instead of emitting one per trade.
      if (last && last.marketId === arr[i].marketId && last.outcome === arr[i].outcome) {
        last.wallets = [...new Set([...last.wallets, ...wallets])];
        last.lastAt = ms(arr[i].timestamp);
        continue;
      }
      clusters.push({
        marketId: arr[i].marketId,
        outcome: arr[i].outcome,
        wallets,
        firstAt: ms(slice[0].timestamp),
        lastAt: ms(arr[i].timestamp),
      });
    }
  }
  return clusters.sort((a, b) => b.lastAt - a.lastAt);
}

/** Recent observed BUYs, for the confluence view. Never throws. */
export function loadRecentForConfluence(db: Db, sinceMs: number, limit = 50_000): ConfluenceTrade[] {
  try {
    return db
      .select({
        id: observedTrades.id,
        walletAddress: observedTrades.walletAddress,
        marketId: observedTrades.marketId,
        outcome: observedTrades.outcome,
        side: observedTrades.side,
        timestamp: observedTrades.timestamp,
      })
      .from(observedTrades)
      .where(gte(observedTrades.timestamp, new Date(sinceMs)))
      .limit(limit)
      .all() as ConfluenceTrade[];
  } catch {
    return [];
  }
}
