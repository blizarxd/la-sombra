import { edgeStats, wilsonLowerBound } from "./stats";

/**
 * 🎯 El Pick del Día — one claim a day, frozen before the outcome is known.
 *
 * The bot copies ~127 signals a day and lands roughly at breakeven. Its own
 * evidence says the value lives in CONCENTRATION, not volume: on the pre-reset
 * data only 0.8% of signals were ever copied, and that thin slice was where the
 * positive cells were. This is that idea taken to its limit — pick ONE.
 *
 * Everything here exists to make the record falsifiable, because an
 * unfalsifiable record is the entire business model of a bad tipster:
 *
 *   · Frozen BEFORE resolution, stamped with the publication time.
 *   · Priced at the ASK — what it would actually cost, spread paid. Marking a
 *     pick at the mid is how a losing record is made to look flat.
 *   · One row per day, enforced by a unique index. No re-picking, no quietly
 *     dropping a bad day.
 *   · Every pick counts, including the ones that never resolve.
 *
 * Pure functions only — selection and scoring. Paper: this records a claim, it
 * never places an order.
 */

/** A scored signal eligible to become today's pick. */
export type PickCandidate = {
  marketId: string;
  tokenId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  walletAddress: string;
  category: string;
  /** Best ask — the price actually payable. */
  entryPrice: number;
  bestBid: number | null;
  copyScore: number;
  confidence: number;
  /** Active gold cell this candidate falls in, if any. */
  cellId: string | null;
  cellLabel: string | null;
  /** The cell's corrected floor — the evidence behind the cell, not the signal. */
  cellFloor: number | null;
  /** Settled real copies behind the cell. */
  cellRealN: number;
};

/** Minimum conviction to publish anything at all. */
export const MIN_PICK_SCORE = 60;
/** Widest spread we will pay on a published pick, in cents. */
export const MAX_PICK_SPREAD = 0.06;

export type PickChoice = {
  candidate: PickCandidate;
  reasoning: string;
};

export function spreadOf(c: PickCandidate): number | null {
  return c.bestBid === null ? null : Math.round((c.entryPrice - c.bestBid) * 10000) / 10000;
}

/**
 * Is this candidate publishable at all? A day with nothing worth publishing
 * must produce NO pick — "no hay pick hoy" is a real answer, and forcing one
 * every day is how a record fills up with coin flips.
 */
export function isEligible(c: PickCandidate): boolean {
  if (!(c.entryPrice > 0) || !(c.entryPrice < 1)) return false;
  if (c.copyScore < MIN_PICK_SCORE) return false;
  if (!c.cellId) return false; // must come from a confirmed gold cell
  const s = spreadOf(c);
  if (s !== null && s > MAX_PICK_SPREAD) return false; // too expensive to enter honestly
  return true;
}

/**
 * Choose the day's pick: the best-EVIDENCED cell first, conviction second.
 *
 * Ranking on the cell's floor rather than the signal's score is deliberate. The
 * score says how confident the bot is about this one signal; the floor says how
 * much the underlying pattern has actually earned the right to be believed. The
 * second question is the one that survives contact with reality.
 */
export function choosePick(candidates: PickCandidate[]): PickChoice | null {
  const eligible = candidates.filter(isEligible);
  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort(
    (a, b) =>
      (b.cellFloor ?? -Infinity) - (a.cellFloor ?? -Infinity) ||
      b.cellRealN - a.cellRealN ||
      b.copyScore - a.copyScore ||
      a.marketId.localeCompare(b.marketId), // deterministic tie-break
  );
  const best = ranked[0];

  const floorTxt =
    best.cellFloor === null ? "sin piso calculable todavía" : `piso ${(best.cellFloor * 100).toFixed(1)}%`;
  const s = spreadOf(best);
  const reasoning =
    `Celda de oro: ${best.cellLabel ?? best.cellId} (${floorTxt}, ${best.cellRealN} copias reales detrás). ` +
    `Puntaje de la señal ${best.copyScore.toFixed(0)}/100. ` +
    `Entrada a ${Math.round(best.entryPrice * 100)}¢${s === null ? "" : ` · spread ${(s * 100).toFixed(1)}¢ pagado`}. ` +
    `Elegido entre ${eligible.length} candidato${eligible.length === 1 ? "" : "s"} del día.`;

  return { candidate: best, reasoning };
}

/** PnL of a $10 unit at `entryPrice` given the final outcome. */
export function pickPnl(entryPrice: number, won: boolean, unit = 10): number | null {
  if (!(entryPrice > 0) || !(entryPrice < 1)) return null;
  const shares = unit / entryPrice;
  return Math.round((shares * (won ? 1 : 0) - unit) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Track record
// ---------------------------------------------------------------------------

export type PickRow = {
  pickDate: string;
  status: string;
  entryPrice: number;
  pnlPer10: number | null;
};

export type PickRecord = {
  total: number;
  open: number;
  settled: number;
  won: number;
  lost: number;
  winRate: number | null;
  /** Wilson floor on the hit rate — the number a buyer should judge you on. */
  winRateFloor: number | null;
  totalPnl: number;
  roi: number;
  /** Corrected floor on per-pick ROI. Null under 2 settled picks. */
  roiFloor: number | null;
  /** Mean entry price: a record of 90¢ favourites is not the same product. */
  avgEntryPrice: number | null;
  /**
   * Break-even hit rate implied by the prices actually paid. Comparing the real
   * hit rate against THIS is the only comparison that means anything — 60%
   * winners at 80¢ is a losing business.
   */
  breakEvenRate: number | null;
  /** Longest run of losses, because that is what a follower actually feels. */
  worstStreak: number;
};

export function summarizeRecord(rows: PickRow[]): PickRecord {
  const settled = rows.filter((r) => r.status === "ganado" || r.status === "perdido");
  const won = settled.filter((r) => r.status === "ganado").length;
  const lost = settled.length - won;
  const pnls = settled.map((r) => r.pnlPer10 ?? 0);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const staked = settled.length * 10;
  const stats = edgeStats(pnls.map((p) => p / 10), 1);

  const prices = settled.map((r) => r.entryPrice).filter((p) => p > 0 && p < 1);
  const avgEntry = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  let streak = 0;
  let worst = 0;
  for (const r of [...rows].sort((a, b) => a.pickDate.localeCompare(b.pickDate))) {
    if (r.status === "perdido") worst = Math.max(worst, ++streak);
    else if (r.status === "ganado") streak = 0;
  }

  return {
    total: rows.length,
    open: rows.filter((r) => r.status === "abierto").length,
    settled: settled.length,
    won,
    lost,
    winRate: settled.length ? won / settled.length : null,
    winRateFloor: settled.length ? wilsonLowerBound(won, settled.length) : null,
    totalPnl: Math.round(totalPnl * 100) / 100,
    roi: staked > 0 ? totalPnl / staked : 0,
    roiFloor: settled.length >= 2 ? stats.lcb : null,
    avgEntryPrice: avgEntry,
    // At price p a winning $10 unit returns 10/p, so you must win p of the time
    // just to stand still.
    breakEvenRate: avgEntry,
    worstStreak: worst,
  };
}
