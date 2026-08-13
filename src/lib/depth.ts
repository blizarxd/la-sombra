import type { DepthLadder } from "@/lib/paper/engine";

/**
 * 📏 DEPTH ANALYSIS — does the measured edge survive a real stake?
 *
 * Every performance number in this project describes copies made at a small
 * fixed size. That is fine for DISCOVERING an edge but says nothing about
 * whether the edge is TRADEABLE: a book deep enough to fill $5 at the touch can
 * charge several cents of slippage for $60, and on a ~57c entry a 2c worse fill
 * is ~3.5% of the position — enough to eat a large slice of a ~14% ROI edge.
 *
 * This aggregates the ladders captured at entry into the only two questions
 * that matter per size: how OFTEN could it fill at all, and how MUCH worse was
 * the price when it did.
 */

export interface DepthRungStats {
  usd: number;
  /** Copies where the book could absorb this size at all. */
  fillable: number;
  total: number;
  fillRate: number;
  /** Median slippage in cents vs the best ask, over fillable copies. */
  medianSlippageCents: number | null;
  /** 90th-percentile slippage — the bad-case fill, not the typical one. */
  p90SlippageCents: number | null;
  /**
   * Median slippage expressed as a % of the position, which is the number
   * directly comparable to the strategy's ROI. Slippage of `c` cents on an
   * entry of `p` cents costs c/p of the stake.
   */
  medianCostPct: number | null;
}

export interface DepthReport {
  sampleSize: number;
  rungs: DepthRungStats[];
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export interface DepthInput {
  ladder: DepthLadder;
  /** Entry price actually paid, used to express slippage as a % of position. */
  entryPrice: number;
}

/** Aggregate captured ladders into per-size fill rate and slippage stats. */
export function analyzeDepth(inputs: DepthInput[]): DepthReport {
  const bySize = new Map<number, { fillable: number; total: number; slip: number[]; cost: number[] }>();
  for (const { ladder, entryPrice } of inputs) {
    for (const rung of ladder.rungs ?? []) {
      let acc = bySize.get(rung.usd);
      if (!acc) {
        acc = { fillable: 0, total: 0, slip: [], cost: [] };
        bySize.set(rung.usd, acc);
      }
      acc.total += 1;
      if (rung.fillable && rung.slippageCents !== null) {
        acc.fillable += 1;
        acc.slip.push(rung.slippageCents);
        // entryPrice is in dollars (0.57); slippage is in cents. Convert.
        if (entryPrice > 0) acc.cost.push(rung.slippageCents / (entryPrice * 100));
      }
    }
  }
  const rungs: DepthRungStats[] = [...bySize.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([usd, acc]) => {
      const slip = [...acc.slip].sort((a, b) => a - b);
      const cost = [...acc.cost].sort((a, b) => a - b);
      const medCost = quantile(cost, 0.5);
      return {
        usd,
        fillable: acc.fillable,
        total: acc.total,
        fillRate: acc.total ? acc.fillable / acc.total : 0,
        medianSlippageCents: quantile(slip, 0.5),
        p90SlippageCents: quantile(slip, 0.9),
        medianCostPct: medCost === null ? null : medCost * 100,
      };
    });
  return { sampleSize: inputs.length, rungs };
}

/** Parse a stored ladder, returning null for missing/corrupt rows (older trades). */
export function parseLadder(json: string | null): DepthLadder | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && Array.isArray(parsed.rungs) ? (parsed as DepthLadder) : null;
  } catch {
    return null;
  }
}
