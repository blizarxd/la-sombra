import type { Rules } from "@/lib/rules";

/**
 * Wallet scoring: pure functions, no I/O. Scores are 0-100.
 */

export interface ResolvedTradeLike {
  pnl: number; // realized USD pnl of the trade
  category: string | null;
  timestampMs: number;
  liquidity: number | null; // market liquidity at/near trade time
  spread: number | null;
  entryDrift: number | null; // |detectedPrice - walletEntryPrice| when we saw it
  entryPrice: number;
  sizeUsd: number;
  inPlay?: boolean; // true if placed after the game/event start (live betting)
}

export interface WalletScoreInput {
  roi30d: number | null; // e.g. 0.15 = +15%
  resolvedTrades: ResolvedTradeLike[];
  tradeCount30d: number;
}

export interface WalletScoreResult {
  roiScore: number;
  consistencyScore: number;
  copyabilityScore: number;
  categoryEdgeScore: number;
  oneHitWonderPenalty: number; // 0-100 penalty points (subtracted, weighted)
  globalScore: number; // 0-100 after penalty
  bestCategory: string | null;
  categoryStrengths: Record<string, { trades: number; pnl: number; winRate: number }>;
  winRate: number | null;
  notes: string[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const clamp100 = (x: number) => Math.min(100, Math.max(0, x));

/** ROI mapped to 0-100. 0% -> 40, +30% -> ~90, negative decays fast. */
export function scoreRoi(roi: number | null): number {
  if (roi === null) return 0;
  if (roi <= -0.5) return 0;
  if (roi < 0) return 40 * (1 + roi / 0.5) * 0.75; // -50%..0% -> 0..30
  return clamp100(40 + 167 * Math.min(roi, 0.36)); // 0..+36% -> 40..100
}

/**
 * Consistency: profits spread across time and trades rather than one streak.
 * Combines (a) share of profitable weeks, (b) 1 - concentration (HHI) of
 * positive pnl across weeks, (c) enough resolved trades.
 */
export function scoreConsistency(trades: ResolvedTradeLike[], minResolved: number): number {
  if (trades.length === 0) return 0;
  const byWeek = new Map<number, number>();
  for (const t of trades) {
    const week = Math.floor(t.timestampMs / (7 * 24 * 3600 * 1000));
    byWeek.set(week, (byWeek.get(week) ?? 0) + t.pnl);
  }
  const weeks = [...byWeek.values()];
  const profitableWeeks = weeks.filter((w) => w > 0).length;
  const weekShare = weeks.length > 0 ? profitableWeeks / weeks.length : 0;

  const positives = weeks.filter((w) => w > 0);
  const totalPos = positives.reduce((a, b) => a + b, 0);
  let hhi = 1; // 1 = all profit in one week (bad)
  if (totalPos > 0 && positives.length > 0) {
    hhi = positives.reduce((acc, w) => acc + (w / totalPos) ** 2, 0);
  }
  const spreadScore = 1 - hhi; // 0 (concentrated) .. ~1 (spread out)

  const volumePenalty = trades.length < minResolved ? trades.length / minResolved : 1;
  return clamp100((weekShare * 55 + spreadScore * 45) * volumePenalty);
}

/**
 * One-hit-wonder penalty (0-100): how much of total profit came from the
 * single best trade. Only penalizes profitable wallets — an unprofitable
 * wallet has bigger problems that ROI already captures.
 */
export function oneHitWonderPenalty(trades: ResolvedTradeLike[], shareThreshold: number): number {
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  if (totalPnl <= 0 || trades.length === 0) return 0;
  const best = Math.max(...trades.map((t) => t.pnl), 0);
  const share = best / totalPnl;
  if (share <= shareThreshold) return 0;
  // share threshold..1 maps to 0..100
  return clamp100(((share - shareThreshold) / (1 - shareThreshold)) * 100);
}

/**
 * Copyability: can a copier realistically follow this wallet?
 * Penalizes illiquid markets, wide spreads, big post-entry drift and
 * extreme entry prices; rewards enough resolved history.
 */
export function scoreCopyability(trades: ResolvedTradeLike[], rules: Rules): number {
  if (trades.length === 0) return 0;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const liqs = trades.map((t) => t.liquidity).filter((x): x is number => x !== null);
  const spreads = trades.map((t) => t.spread).filter((x): x is number => x !== null);
  const drifts = trades.map((t) => t.entryDrift).filter((x): x is number => x !== null);

  const avgLiq = avg(liqs);
  const avgSpread = avg(spreads);
  const avgDrift = avg(drifts);

  // Liquidity: log-scale vs minLiquidity. 1x min -> 0.5, 10x min -> 1.0
  const liqScore =
    avgLiq === null ? 0.4 : clamp01(0.5 + 0.5 * (Math.log10(Math.max(avgLiq, 1) / rules.minLiquidity) / 1));
  // Spread: at or under half of maxSpread -> 1, at maxSpread -> 0.4, beyond -> 0
  const spreadScore =
    avgSpread === null
      ? 0.4
      : avgSpread <= rules.maxSpread / 2
        ? 1
        : avgSpread <= rules.maxSpread
          ? 1 - (0.6 * (avgSpread - rules.maxSpread / 2)) / (rules.maxSpread / 2)
          : Math.max(0, 0.4 - (avgSpread - rules.maxSpread) * 8);
  // Drift: if price runs away right after entry, followers can't copy.
  const driftScore = avgDrift === null ? 0.5 : clamp01(1 - avgDrift / rules.maxPriceDrift);
  // Entry band: share of entries inside the copyable band.
  const inBand = trades.filter(
    (t) => t.entryPrice >= rules.minEntryPrice && t.entryPrice <= rules.maxEntryPrice,
  ).length;
  const bandScore = inBand / trades.length;
  // History depth
  const historyScore = clamp01(trades.length / (rules.minResolvedTrades * 2));

  return clamp100(
    (liqScore * 0.3 + spreadScore * 0.25 + driftScore * 0.2 + bandScore * 0.15 + historyScore * 0.1) * 100,
  );
}

/** Category edge: does the wallet have a category where it clearly wins? */
export function scoreCategoryEdge(trades: ResolvedTradeLike[]): {
  score: number;
  bestCategory: string | null;
  strengths: Record<string, { trades: number; pnl: number; winRate: number }>;
} {
  const strengths: Record<string, { trades: number; pnl: number; winRate: number }> = {};
  const byCat = new Map<string, ResolvedTradeLike[]>();
  for (const t of trades) {
    const cat = t.category ?? "Other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(t);
  }
  let best: { cat: string; score: number } | null = null;
  for (const [cat, ts] of byCat) {
    const pnl = ts.reduce((a, t) => a + t.pnl, 0);
    const wins = ts.filter((t) => t.pnl > 0).length;
    const winRate = ts.length ? wins / ts.length : 0;
    strengths[cat] = { trades: ts.length, pnl: Math.round(pnl * 100) / 100, winRate };
    if (ts.length >= 3) {
      const catScore = winRate * 70 + (pnl > 0 ? 30 : 0);
      if (!best || catScore > best.score) best = { cat, score: catScore };
    }
  }
  return { score: best ? clamp100(best.score) : 30, bestCategory: best?.cat ?? null, strengths };
}

/** Full wallet score. */
export function scoreWallet(input: WalletScoreInput, rules: Rules): WalletScoreResult {
  const notes: string[] = [];
  const roiScore = scoreRoi(input.roi30d);
  const consistencyScore = scoreConsistency(input.resolvedTrades, rules.minResolvedTrades);
  const copyabilityScore = scoreCopyability(input.resolvedTrades, rules);
  const catEdge = scoreCategoryEdge(input.resolvedTrades);
  const penalty = oneHitWonderPenalty(input.resolvedTrades, rules.oneHitWonderShareThreshold);

  const w = rules.walletWeights;
  const base =
    roiScore * w.roi +
    consistencyScore * w.consistency +
    copyabilityScore * w.copyability +
    catEdge.score * w.categoryEdge;
  // Penalty removes up to 35 points from the global score.
  const globalScore = clamp100(base - penalty * 0.35);

  const wins = input.resolvedTrades.filter((t) => t.pnl > 0).length;
  const winRate = input.resolvedTrades.length ? wins / input.resolvedTrades.length : null;

  if (penalty > 0) notes.push(`one-hit-wonder: top trade is ${Math.round(penalty)}pt penalty`);
  if (input.resolvedTrades.length < rules.minResolvedTrades)
    notes.push(`only ${input.resolvedTrades.length} resolved trades (< ${rules.minResolvedTrades})`);
  if (copyabilityScore < 40) notes.push("hard to copy: illiquid markets / wide spreads / fast drift");

  return {
    roiScore,
    consistencyScore,
    copyabilityScore,
    categoryEdgeScore: catEdge.score,
    oneHitWonderPenalty: penalty,
    globalScore,
    bestCategory: catEdge.bestCategory,
    categoryStrengths: catEdge.strengths,
    winRate,
    notes,
  };
}

/** Map a global score to a tracking status. */
export function statusForScore(globalScore: number, rules: Rules): "track" | "watch" | "ignore" {
  if (globalScore >= rules.minWalletGlobalScore) return "track";
  if (globalScore >= rules.minWalletGlobalScore * 0.7) return "watch";
  return "ignore";
}
