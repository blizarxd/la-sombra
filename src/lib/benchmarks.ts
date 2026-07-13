/**
 * Benchmark math: compare the bot-filtered strategy against blindly copying
 * every observed trade, plus watchlist/skip hypotheticals.
 * Pure functions over rows the scripts/pages read from the DB.
 */

export interface DecisionOutcomeRow {
  decision: "paper_copy" | "watchlist" | "skip";
  /** Realized paper pnl (for copies) — null if still open/unknown. */
  paperPnl: number | null;
  /**
   * Hypothetical pnl per $10 if we had copied this signal at detected price
   * and held to resolution/now. Null if unknown.
   */
  hypotheticalPnl: number | null;
  resolved: boolean;
}

export interface BenchmarkSummary {
  botFiltered: GroupStats;
  blindCopy: GroupStats; // every signal, hypothetical $10 each
  watchlistOnly: GroupStats;
  skippedOnly: GroupStats;
  missedWinners: number; // skipped/watchlisted signals that ended profitable
  avoidedLosers: number; // skipped signals that ended losing
  badCopies: number; // copies that lost
  goodSkips: number; // alias of avoidedLosers among resolved skips
  botBeatsBlind: boolean | null;
}

export interface GroupStats {
  count: number;
  resolvedCount: number;
  totalPnl: number;
  winRate: number | null;
  avgPnl: number | null;
}

function groupStats(pnls: (number | null)[]): GroupStats {
  const resolved = pnls.filter((p): p is number => p !== null);
  const wins = resolved.filter((p) => p > 0).length;
  const total = resolved.reduce((a, b) => a + b, 0);
  return {
    count: pnls.length,
    resolvedCount: resolved.length,
    totalPnl: Math.round(total * 100) / 100,
    winRate: resolved.length ? wins / resolved.length : null,
    avgPnl: resolved.length ? Math.round((total / resolved.length) * 100) / 100 : null,
  };
}

export function computeBenchmarks(rows: DecisionOutcomeRow[]): BenchmarkSummary {
  const copies = rows.filter((r) => r.decision === "paper_copy");
  const watch = rows.filter((r) => r.decision === "watchlist");
  const skips = rows.filter((r) => r.decision === "skip");

  const botFiltered = groupStats(copies.map((r) => r.paperPnl));
  const blindCopy = groupStats(rows.map((r) => r.hypotheticalPnl));
  const watchlistOnly = groupStats(watch.map((r) => r.hypotheticalPnl));
  const skippedOnly = groupStats(skips.map((r) => r.hypotheticalPnl));

  const missedWinners =
    watch.filter((r) => r.resolved && (r.hypotheticalPnl ?? 0) > 0).length +
    skips.filter((r) => r.resolved && (r.hypotheticalPnl ?? 0) > 0).length;
  const avoidedLosers = skips.filter((r) => r.resolved && (r.hypotheticalPnl ?? 0) < 0).length;
  const badCopies = copies.filter((r) => r.resolved && (r.paperPnl ?? 0) < 0).length;

  let botBeatsBlind: boolean | null = null;
  if (botFiltered.resolvedCount > 0 && blindCopy.resolvedCount > 0) {
    botBeatsBlind = (botFiltered.avgPnl ?? 0) > (blindCopy.avgPnl ?? 0);
  }

  return {
    botFiltered,
    blindCopy,
    watchlistOnly,
    skippedOnly,
    missedWinners,
    avoidedLosers,
    badCopies,
    goodSkips: avoidedLosers,
    botBeatsBlind,
  };
}

/**
 * Hypothetical pnl of copying a signal with $10 at `entryPrice`,
 * given a final (or current) price. Long-only, payout at price.
 */
export function hypotheticalPnl(entryPrice: number, finalPrice: number, usd = 10): number | null {
  if (entryPrice <= 0 || entryPrice >= 1) return null;
  const shares = usd / entryPrice;
  return Math.round((shares * finalPrice - usd) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Skip autopsy: which filter gate is leaking profitable signals?
// For every signal the bot did NOT copy, we know (a) the gate that blocked it
// and (b) what it would have earned (hypothetical $10 to resolution/now). Group
// by gate to see, per filter: how much profit it blocked (missed winners) vs how
// much loss it saved (avoided losers). A POSITIVE net means that gate is costing
// us money — the concrete target to loosen. This turns the vague "blind copy
// beats the bot" into an actionable, per-gate diagnosis.
// ---------------------------------------------------------------------------
export interface SkipAutopsyRow {
  blockedGate: string | null;
  /** Hypothetical pnl per $10 had we copied this blocked signal. Null if unknown. */
  hypotheticalPnl: number | null;
}

export interface GateLeak {
  gate: string;
  blocked: number; // signals this gate blocked
  resolved: number; // of those, how many have a known outcome
  missedWinners: number; // $ of profit blocked (sum of positive hypotheticals)
  avoidedLosers: number; // $ of loss saved (sum of negative hypotheticals, as a positive number)
  net: number; // missedWinners - avoidedLosers; >0 = this gate leaks money
}

/** Per-gate leak table, worst leak (highest positive net) first. */
export function computeSkipAutopsy(rows: SkipAutopsyRow[]): GateLeak[] {
  const byGate = new Map<string, GateLeak>();
  for (const r of rows) {
    if (!r.blockedGate) continue; // copied signals aren't blocked
    const g =
      byGate.get(r.blockedGate) ??
      { gate: r.blockedGate, blocked: 0, resolved: 0, missedWinners: 0, avoidedLosers: 0, net: 0 };
    g.blocked++;
    if (r.hypotheticalPnl !== null) {
      g.resolved++;
      if (r.hypotheticalPnl > 0) g.missedWinners += r.hypotheticalPnl;
      else if (r.hypotheticalPnl < 0) g.avoidedLosers += -r.hypotheticalPnl;
    }
    byGate.set(r.blockedGate, g);
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  return [...byGate.values()]
    .map((g) => ({
      ...g,
      missedWinners: round(g.missedWinners),
      avoidedLosers: round(g.avoidedLosers),
      net: round(g.missedWinners - g.avoidedLosers),
    }))
    .sort((a, b) => b.net - a.net);
}
