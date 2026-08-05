import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { decisionJournal, observedTrades, paperTrades } from "@/db/schema";
import { categorizeMarket } from "./category";
import { hourBlockKey, priceBandKey } from "./slices";
import { mean } from "./stats";

/**
 * 🩸 El Arrastre — what copying costs before the bet is even judged.
 *
 * Two prices have always been stored and never once subtracted:
 *   · `observed_trades.wallet_entry_price` — what the wallet we follow paid
 *   · `paper_trades.entry_price`           — what we paid, a beat later
 *
 * If the wallet buys at 62¢ and we fill at 67¢, the whole edge is gone before
 * the market resolves. The difference is not variance and not bad luck: it is a
 * fixed toll on every copy, and it was invisible.
 *
 * It also tests an uncomfortable hypothesis. Our "best wallets" may not be the
 * smartest ones — they may just be the ones we happen to copy FAST, in thin
 * markets that don't move on their own order. A cell whose edge is smaller than
 * its drag is not a vein; it is an accounting illusion.
 *
 * Pure math + one read-only query. No orders, ever.
 */

export type DragRow = {
  /** Price the followed wallet got. */
  walletEntryPrice: number;
  /** Price our simulated fill got. */
  ourEntryPrice: number;
  /** Wallet's trade timestamp. */
  walletAt: Date | number | null;
  /** When our copy opened. */
  ourAt: Date | number | null;
  walletAddress: string;
  marketQuestion: string | null;
  realizedPnl: number | null;
  simulatedPositionSize: number;
};

export type DragStats = {
  n: number;
  /** Mean price difference in CENTS. Positive = we paid more than the wallet. */
  dragCents: number;
  /**
   * Mean share of expected ROI handed over, using the wallet's own price as the
   * market's implied probability: 1 − p_wallet / p_ours.
   * 0.075 means three-quarters of a ten-percent edge was gone at entry.
   */
  roiGivenUp: number;
  /** Mean minutes between the wallet's trade and our copy. Null if unknown. */
  latencyMinutes: number | null;
  /** Realized ROI of these copies, for comparison against what the drag ate. */
  realizedRoi: number | null;
};

const ms = (d: Date | number | null | undefined): number | null =>
  d == null ? null : d instanceof Date ? d.getTime() : d;

/** Fraction of expected ROI given up by filling at `ours` instead of `wallet`. */
export function roiGivenUp(walletPrice: number, ourPrice: number): number | null {
  if (!(walletPrice > 0) || !(walletPrice < 1) || !(ourPrice > 0) || !(ourPrice < 1)) return null;
  return 1 - walletPrice / ourPrice;
}

export function summarizeDrag(rows: DragRow[]): DragStats {
  const cents: number[] = [];
  const given: number[] = [];
  const lat: number[] = [];
  let pnl = 0;
  let staked = 0;
  for (const r of rows) {
    const g = roiGivenUp(r.walletEntryPrice, r.ourEntryPrice);
    if (g === null) continue;
    cents.push((r.ourEntryPrice - r.walletEntryPrice) * 100);
    given.push(g);
    const a = ms(r.walletAt);
    const b = ms(r.ourAt);
    if (a !== null && b !== null && b >= a) lat.push((b - a) / 60_000);
    if (r.realizedPnl !== null) {
      pnl += r.realizedPnl;
      staked += r.simulatedPositionSize || 0;
    }
  }
  return {
    n: cents.length,
    dragCents: cents.length ? mean(cents) : 0,
    roiGivenUp: given.length ? mean(given) : 0,
    latencyMinutes: lat.length ? mean(lat) : null,
    realizedRoi: staked > 0 ? pnl / staked : null,
  };
}

export type DragBreakdown = { key: string; label: string; stats: DragStats };

/** Group the drag by an arbitrary key so the toll can be located, not just totalled. */
export function dragBy(
  rows: DragRow[],
  keyOf: (r: DragRow) => string | null,
  labelOf: (key: string) => string = (k) => k,
  minN = 5,
): DragBreakdown[] {
  const groups = new Map<string, DragRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, label: labelOf(key), stats: summarizeDrag(rs) }))
    .filter((g) => g.stats.n >= minN)
    .sort((a, b) => b.stats.roiGivenUp - a.stats.roiGivenUp); // worst toll first
}

/** Latency buckets — the axis that tells us whether speed is the whole story. */
export function latencyBucket(r: DragRow): string | null {
  const a = ms(r.walletAt);
  const b = ms(r.ourAt);
  if (a === null || b === null || b < a) return null;
  const m = (b - a) / 60_000;
  if (m < 1) return "l00";
  if (m < 5) return "l01";
  if (m < 15) return "l05";
  if (m < 60) return "l15";
  return "l60";
}

export const LATENCY_LABELS: Record<string, string> = {
  l00: "⚡ < 1 min",
  l01: "1–5 min",
  l05: "5–15 min",
  l15: "15–60 min",
  l60: "🐌 > 1 hora",
};

export function bandOf(r: DragRow): string | null {
  return priceBandKey(r.ourEntryPrice);
}

export function categoryOf(r: DragRow): string | null {
  return categorizeMarket(r.marketQuestion);
}

export function hourOf(r: DragRow): string | null {
  const a = ms(r.ourAt);
  return a === null ? null : hourBlockKey(a);
}

/**
 * Every paper copy paired with the wallet trade it came from.
 * Returns [] (never throws) if the join is unavailable on an older database.
 */
export function loadDragRows(db: Db, limit = 50_000): DragRow[] {
  try {
    return db
      .select({
        walletEntryPrice: observedTrades.walletEntryPrice,
        ourEntryPrice: paperTrades.entryPrice,
        walletAt: observedTrades.timestamp,
        ourAt: paperTrades.openedAt,
        walletAddress: paperTrades.walletAddress,
        marketQuestion: paperTrades.marketQuestion,
        realizedPnl: paperTrades.realizedPnl,
        simulatedPositionSize: paperTrades.simulatedPositionSize,
      })
      .from(paperTrades)
      .innerJoin(decisionJournal, eq(paperTrades.decisionJournalId, decisionJournal.id))
      .innerJoin(observedTrades, eq(decisionJournal.observedTradeId, observedTrades.id))
      .where(and(eq(paperTrades.side, "BUY"), isNotNull(observedTrades.walletEntryPrice), sql`${paperTrades.entryPrice} > 0`))
      .limit(limit)
      .all() as DragRow[];
  } catch {
    return [];
  }
}
