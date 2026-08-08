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

/** How many picks get published: 1 principal + 3 vetted alternates. */
export const SHORTLIST_SIZE = 4;

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
export function choosePicks(candidates: PickCandidate[], limit = SHORTLIST_SIZE): PickChoice[] {
  const eligible = candidates.filter(isEligible);
  if (eligible.length === 0) return [];

  const ranked = [...eligible].sort(
    (a, b) =>
      (b.cellFloor ?? -Infinity) - (a.cellFloor ?? -Infinity) ||
      b.cellRealN - a.cellRealN ||
      b.copyScore - a.copyScore ||
      a.marketId.localeCompare(b.marketId), // deterministic tie-break
  );

  return ranked.slice(0, limit).map((c, i) => {
    const floorTxt = c.cellFloor === null ? "sin piso calculable todavía" : `piso ${(c.cellFloor * 100).toFixed(1)}%`;
    const s = spreadOf(c);
    const role = i === 0 ? "PICK DEL DÍA" : `alternativa #${i + 1}`;
    return {
      candidate: c,
      reasoning:
        `${role}. Celda de oro: ${c.cellLabel ?? c.cellId} (${floorTxt}, ${c.cellRealN} copias reales detrás). ` +
        `Puntaje de la señal ${c.copyScore.toFixed(0)}/100. ` +
        `Entrada a ${Math.round(c.entryPrice * 100)}¢${s === null ? "" : ` · spread ${(s * 100).toFixed(1)}¢ pagado`}. ` +
        `Elegido entre ${eligible.length} candidato${eligible.length === 1 ? "" : "s"} del día.`,
    };
  });
}

/** Back-compat single-pick helper. */
export function choosePick(candidates: PickCandidate[]): PickChoice | null {
  return choosePicks(candidates, 1)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Combining two picks by hand
// ---------------------------------------------------------------------------

export type ComboMath = {
  /** Fair combined price if the two events are independent: p1 × p2. */
  combinedPrice: number;
  /** Payout multiple on a true parlay at that price. */
  multiple: number;
  /**
   * Probability both land, using each leg's price as its implied probability.
   * Same number as combinedPrice — which is the point: a parlay priced fairly
   * has ZERO edge, and every cent of spread comes straight off the top.
   */
  bothLandRate: number;
  /** Combined spread paid across both legs, in cents. */
  spreadCents: number | null;
  /**
   * Share of the combined price that is pure spread. This is the number that
   * decides it: two legs means paying the toll twice, compounded.
   */
  spreadDrag: number | null;
  /** Expected value of $10 on a true parlay, priced off the mid. */
  evPer10: number | null;
};

/**
 * The honest arithmetic of stapling two picks together.
 *
 * Two separate singles are NOT a parlay — they pay out independently, which is
 * diversification (lower variance). A real parlay needs BOTH to land and pays
 * the multiplied odds. The two are opposite bets and the page must not blur them.
 */
export function comboMath(a: PickCandidate | PickRow2, b: PickCandidate | PickRow2): ComboMath {
  const p1 = a.entryPrice;
  const p2 = b.entryPrice;
  const combined = p1 * p2;
  const s1 = a.bestBid === null || a.bestBid === undefined ? null : p1 - a.bestBid;
  const s2 = b.bestBid === null || b.bestBid === undefined ? null : p2 - b.bestBid;

  let spreadCents: number | null = null;
  let spreadDrag: number | null = null;
  let evPer10: number | null = null;
  if (s1 !== null && s2 !== null) {
    // What the same parlay would cost priced at the mid of each leg.
    const fair = (p1 - s1 / 2) * (p2 - s2 / 2);
    spreadCents = Math.round((combined - fair) * 10000) / 100;
    spreadDrag = combined > 0 ? (combined - fair) / combined : null;
    // Buy at `combined`, true chance `fair`: the gap is the expected loss.
    evPer10 = Math.round(((fair / combined) * 10 - 10) * 100) / 100;
  }

  return {
    combinedPrice: combined,
    multiple: combined > 0 ? 1 / combined : 0,
    bothLandRate: combined,
    spreadCents,
    spreadDrag,
    evPer10,
  };
}

/** Minimal shape a stored pick exposes for combo math. */
export type PickRow2 = { entryPrice: number; bestBid?: number | null };

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

export type DayRow = {
  pickDate: string;
  rank: number;
  status: string;
  entryPrice: number;
  pnlPer10: number | null;
  marketQuestion?: string | null;
  outcome?: string | null;
  cellLabel?: string | null;
};

export type DaySummary = {
  date: string;
  /** The day's rank-1 pick, or null on a day that produced none. */
  main: DayRow | null;
  alternates: DayRow[];
  /** Result of the official pick only. */
  status: string;
  pnlPer10: number | null;
  /** Running total of the official record up to and including this day. */
  cumulativePnl: number;
  /** True when the day published nothing — a real outcome, not a gap in the data. */
  noPick: boolean;
};

/**
 * One row per CALENDAR day, oldest first, including days that produced no pick.
 *
 * Rendering only the days that happen to have picks would quietly hide the
 * skips, and "how often does it even fire?" is part of judging a tipster. A day
 * with no pick is a result, so it gets a row.
 */
export function byCalendarDay(rows: DayRow[], todayKey?: string): DaySummary[] {
  if (rows.length === 0) return [];
  const byDate = new Map<string, DayRow[]>();
  for (const r of rows) {
    const arr = byDate.get(r.pickDate) ?? [];
    arr.push(r);
    byDate.set(r.pickDate, arr);
  }

  const dates = [...byDate.keys()].sort();
  const first = dates[0];
  const last = todayKey && todayKey > dates[dates.length - 1] ? todayKey : dates[dates.length - 1];

  const out: DaySummary[] = [];
  let cumulative = 0;
  for (let d = first; d <= last; d = nextDay(d)) {
    const day = byDate.get(d) ?? [];
    const main = day.find((r) => r.rank === 1) ?? null;
    if (main?.pnlPer10 != null) cumulative += main.pnlPer10;
    out.push({
      date: d,
      main,
      alternates: day.filter((r) => r.rank !== 1).sort((a, b) => a.rank - b.rank),
      status: main?.status ?? "sin-pick",
      pnlPer10: main?.pnlPer10 ?? null,
      cumulativePnl: Math.round(cumulative * 100) / 100,
      noPick: !main,
    });
  }
  return out;
}

/** Next YYYY-MM-DD, calendar-correct across months and leap years. */
export function nextDay(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

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
