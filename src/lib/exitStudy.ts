import { asc, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { pnlSnapshots } from "@/db/schema";
import { edgeStats } from "./stats";

/**
 * 🚪 El estudio de salida — we only ever learned how to ENTER.
 *
 * Every book holds to resolution. Nobody ever asked what the alternative was
 * worth, even though `pnl_snapshots` has been recording the whole price path of
 * every position, hour by hour, since the beginning.
 *
 * This answers that offline: given the path a position actually took, what would
 * a take-profit or a stop-loss have produced instead? It changes NOTHING about
 * how the bot trades — it is arithmetic over data we already have, and its output
 * is a report for the daily cut to argue with.
 *
 * Honest limits, stated up front because they decide how much this is worth:
 *   · Snapshots are hourly, so a rule can only ever fire at a snapshot. Real
 *     intraday spikes between marks are invisible, which makes every exit result
 *     here a LOWER bound on what a live rule would have caught.
 *   · Exits are marked at the snapshot price, i.e. mid — a real exit crosses the
 *     spread, so these numbers are optimistic by roughly one spread per trade.
 * Both biases are stated in the report rather than silently corrected.
 */

export type PricePoint = { at: number; pnl: number };

export type PositionPath = {
  paperTradeId: string;
  track: string;
  stake: number;
  /** Realized PnL of actually holding to the end. The baseline to beat. */
  heldPnl: number;
  /** Hourly marks, oldest first. */
  path: PricePoint[];
};

export type ExitPolicy = {
  key: string;
  label: string;
  /** Take profit when PnL reaches this fraction of stake (null = never). */
  takeProfit: number | null;
  /** Cut when PnL falls to this fraction of stake, negative (null = never). */
  stopLoss: number | null;
};

export const EXIT_POLICIES: ExitPolicy[] = [
  { key: "hold", label: "🪨 Aguantar hasta resolver (lo que hacemos hoy)", takeProfit: null, stopLoss: null },
  { key: "tp30", label: "💰 Tomar ganancia a +30%", takeProfit: 0.3, stopLoss: null },
  { key: "tp50", label: "💰 Tomar ganancia a +50%", takeProfit: 0.5, stopLoss: null },
  { key: "tp100", label: "💰 Tomar ganancia a +100%", takeProfit: 1.0, stopLoss: null },
  { key: "sl50", label: "🛑 Cortar pérdida a −50%", takeProfit: null, stopLoss: -0.5 },
  { key: "tp50sl50", label: "⚖️ +50% arriba / −50% abajo", takeProfit: 0.5, stopLoss: -0.5 },
];

/** PnL the policy would have produced on one position. */
export function applyPolicy(pos: PositionPath, policy: ExitPolicy): number {
  if (policy.takeProfit === null && policy.stopLoss === null) return pos.heldPnl;
  const stake = pos.stake > 0 ? pos.stake : 1;
  for (const point of pos.path) {
    const r = point.pnl / stake;
    if (policy.takeProfit !== null && r >= policy.takeProfit) return point.pnl;
    if (policy.stopLoss !== null && r <= policy.stopLoss) return point.pnl;
  }
  return pos.heldPnl; // never triggered → same as holding
}

export type PolicyResult = {
  key: string;
  label: string;
  n: number;
  totalPnl: number;
  roi: number;
  /** Shrunk lower bound on per-trade ROI — a policy chosen off a headline is a fluke. */
  lcb: number | null;
  winRate: number;
  /** How many positions the rule actually fired on. */
  triggered: number;
  /** Difference against holding. Positive = the rule would have helped. */
  vsHold: number;
};

export function studyExits(positions: PositionPath[], policies: ExitPolicy[] = EXIT_POLICIES): PolicyResult[] {
  const held = positions.reduce((a, p) => a + p.heldPnl, 0);
  return policies.map((policy) => {
    const rois: number[] = [];
    let total = 0;
    let triggered = 0;
    for (const pos of positions) {
      const pnl = applyPolicy(pos, policy);
      if (pnl !== pos.heldPnl) triggered++;
      total += pnl;
      if (pos.stake > 0) rois.push(pnl / pos.stake);
    }
    const stats = edgeStats(rois, policies.length);
    return {
      key: policy.key,
      label: policy.label,
      n: positions.length,
      totalPnl: Math.round(total * 100) / 100,
      roi: stats.roi,
      lcb: stats.lcb,
      winRate: stats.winRate,
      triggered,
      vsHold: Math.round((total - held) * 100) / 100,
    };
  });
}

/**
 * Attach the recorded price path to each settled position.
 * Positions without snapshots keep an empty path, so every policy falls back to
 * holding for them — never a fabricated exit.
 */
export function attachPaths(
  positions: Array<Omit<PositionPath, "path">>,
  snapshots: Array<{ paperTradeId: string; pnl: number; collectedAt: Date | number }>,
): PositionPath[] {
  const byTrade = new Map<string, PricePoint[]>();
  for (const s of snapshots) {
    const arr = byTrade.get(s.paperTradeId) ?? [];
    arr.push({ at: s.collectedAt instanceof Date ? s.collectedAt.getTime() : s.collectedAt, pnl: s.pnl });
    byTrade.set(s.paperTradeId, arr);
  }
  for (const arr of byTrade.values()) arr.sort((a, b) => a.at - b.at);
  return positions.map((p) => ({ ...p, path: byTrade.get(p.paperTradeId) ?? [] }));
}

/** Load the recorded marks for a set of positions. Never throws. */
export function loadPaths(db: Db, paperTradeIds: string[]) {
  if (paperTradeIds.length === 0) return [];
  try {
    return db
      .select({
        paperTradeId: pnlSnapshots.paperTradeId,
        pnl: pnlSnapshots.pnl,
        collectedAt: pnlSnapshots.collectedAt,
      })
      .from(pnlSnapshots)
      .where(inArray(pnlSnapshots.paperTradeId, paperTradeIds))
      .orderBy(asc(pnlSnapshots.collectedAt))
      .all();
  } catch {
    return [];
  }
}
