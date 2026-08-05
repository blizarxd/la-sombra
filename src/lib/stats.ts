/**
 * 📉 Honest small-sample statistics.
 *
 * Every "winning cell" in this project is chosen as the MAXIMUM over hundreds of
 * candidate slices. That is the oldest trap in quantitative research: the best of
 * 300 coin-flips always looks like skill. Raw ROI has no defence against it —
 * a cell with n=5 and +61% outranks n=299 and +8%, and the dashboard crowns the
 * noise.
 *
 * The defence here is to never rank by the point estimate. Rank by the LOWER
 * BOUND of a confidence interval: "what is the worst this cell plausibly is?".
 * That single change makes sample size and variance part of the score instead of
 * a footnote, so a big boring cell beats a small spectacular one automatically.
 *
 * Pure math only — no I/O, no trades, no orders.
 */

/** One-sided z scores. 90% is the working gate; 95% is for the strict view. */
export const Z_90 = 1.2816;
export const Z_95 = 1.6449;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n−1). Returns 0 for n<2. */
export function stdDev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(ss / (n - 1));
}

/** Standard error of the mean. Null when there is no sample to speak of. */
export function stdErr(xs: number[]): number | null {
  if (xs.length < 2) return null;
  return stdDev(xs) / Math.sqrt(xs.length);
}

/**
 * Lower confidence bound on the mean of `xs`.
 *
 * Null (not zero, not the mean) when n<2 — "we don't know" and "it's bad" are
 * different answers, and collapsing them is how a one-trade cell becomes a rule.
 */
export function meanLowerBound(xs: number[], z: number = Z_90): number | null {
  const se = stdErr(xs);
  if (se === null) return null;
  return mean(xs) - z * se;
}

/**
 * Wilson lower bound on a proportion — the right interval for win rates, because
 * the normal approximation breaks exactly where we care (near 0% and 100%, tiny n).
 */
export function wilsonLowerBound(wins: number, n: number, z: number = Z_90): number | null {
  if (n <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Inverse standard-normal CDF (Acklam's rational approximation, |error| < 1.2e-9).
 * Needed to turn an arbitrary alpha into a z score for the multiplicity view.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * The z score that keeps the FAMILY-wide false-positive rate at `alpha` when
 * `cellsTested` cells compete for the crown (Šidák, slightly tighter than
 * Bonferroni). Scanning 200 cells at the usual 90% bar means ~20 fake winners;
 * this is the number that says how much of the edge survives that correction.
 *
 * Deliberately NOT the default gate: at n≈30 it rejects almost everything, and a
 * strategy that never acts learns nothing. It is reported alongside as the
 * reality check on how much of a "discovery" is really selection.
 */
export function multiplicityZ(cellsTested: number, alpha = 0.05): number {
  const m = Math.max(1, cellsTested);
  const perTest = 1 - Math.pow(1 - alpha, 1 / m);
  return -inverseNormalCdf(perTest);
}

/**
 * Empirical-Bayes prior for a freshly discovered cell. Encodes the belief that
 * should be the default in this project: a new cell is probably NOT special.
 *
 * Why it is needed, concretely: five trades that all won +100% have a sample
 * variance of exactly ZERO, so an uncorrected bound puts its floor at +100% and
 * the fluke wins every ranking. Five identical outcomes is what a lucky streak
 * looks like — not proof that the cell is riskless. Shrinking the mean toward no
 * edge and pooling the variance toward a realistic dispersion fixes both holes
 * with one standard move.
 */
export const PRIOR_TRADES = 8; // pseudo-observations of "no edge"
export const PRIOR_ROI = 0; // ...and what that no-edge looks like
export const PRIOR_SD = 0.8; // per-trade ROI dispersion typical of a binary market

export type EdgeStats = {
  n: number;
  /** Mean per-trade ROI (pnl / stake). */
  roi: number;
  /** Lower bound on that mean. Null when n<2 — unknown, not bad. */
  lcb: number | null;
  /** Same bound after correcting for how many cells competed. Null when n<2. */
  strictLcb: number | null;
  winRate: number;
  /** Wilson lower bound on the win rate. */
  winRateLcb: number | null;
};

/**
 * Shrunk mean and standard error for a cell, using the no-edge prior above.
 * Null when there is nothing to shrink.
 */
export function shrunkEdge(perTradeRois: number[]): { mean: number; se: number } | null {
  const n = perTradeRois.length;
  // One trade carries no information about spread at all; the prior alone would
  // be inventing a bound out of a single coin flip.
  if (n < 2) return null;
  const m = mean(perTradeRois);
  const shrunkMean = (n * m + PRIOR_TRADES * PRIOR_ROI) / (n + PRIOR_TRADES);
  const sampleVar = n >= 2 ? Math.pow(stdDev(perTradeRois), 2) : 0;
  const pooledVar = ((n - 1) * sampleVar + PRIOR_TRADES * PRIOR_SD * PRIOR_SD) / (n - 1 + PRIOR_TRADES);
  return { mean: shrunkMean, se: Math.sqrt(pooledVar / n) };
}

/**
 * Summarize one cell from its per-trade ROIs.
 *
 * `roi` is the raw point estimate (what the cell actually did). `lcb` and
 * `strictLcb` are the shrunk bounds — what it is worth BETTING on, which is a
 * different and much more conservative question. `cellsTested` feeds the
 * multiplicity view; pass 1 when nothing was selected.
 */
export function edgeStats(perTradeRois: number[], cellsTested = 1, z: number = Z_90): EdgeStats {
  const n = perTradeRois.length;
  const wins = perTradeRois.filter((r) => r > 0).length;
  const shrunk = shrunkEdge(perTradeRois);
  return {
    n,
    roi: mean(perTradeRois),
    lcb: shrunk ? shrunk.mean - z * shrunk.se : null,
    strictLcb: shrunk ? shrunk.mean - multiplicityZ(cellsTested) * shrunk.se : null,
    winRate: n > 0 ? wins / n : 0,
    winRateLcb: wilsonLowerBound(wins, n, z),
  };
}
