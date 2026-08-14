import { and, desc, eq, gte, inArray, like, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  aiAnalyses,
  capitalBook,
  cremaEvolution,
  fastBook,
  dailyPicks,
  dailyReports,
  decisionJournal,
  eliteRoster,
  leaderboardScans,
  marketSnapshots,
  observedTrades,
  outcomeReviews,
  paperTrades,
  pnlSnapshots,
  ruleChanges,
  ruleSets,
  walletProfiles,
} from "@/db/schema";
import { canonicalGoldRule, loadAllCells } from "./cremaCells";
import { byCalendarDay, summarizeRecord } from "./dailyPick";
import {
  computeBenchmarks,
  computeSkipAutopsy,
  hypotheticalPnl,
  type DecisionOutcomeRow,
} from "./benchmarks";
import { categorizeMarket, type CategoryKey } from "./category";
import { analyzeDepth, parseLadder } from "./depth";
import { CAPITAL_START, FLAT_STAKE } from "./capitalBook";
import { dayKeyTz } from "./format";
import { isCryptoBookEligible } from "./profiler";
import { getActiveRules } from "./rules";
import { projectOpenByWindow } from "./projection";
import { buildAllMatrices, type SettledTrade } from "./slices";

/** Shared read-model helpers used by the dashboard pages and reports. */

/**
 * SQLite caps the number of host parameters per statement at 32766. An
 * `inArray(col, ids)` with a longer id list throws "too many SQL variables"
 * (it took down Resumen + Rendimiento once the decision journal grew past that).
 * This batches the ids so an arbitrarily large list never overflows.
 */
export const SQLITE_VAR_LIMIT = 20000; // comfortably under 32766
export function selectByIdsChunked<T>(ids: string[], run: (batch: string[]) => T[]): T[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length <= SQLITE_VAR_LIMIT) return run(unique);
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += SQLITE_VAR_LIMIT) {
    out.push(...run(unique.slice(i, i + SQLITE_VAR_LIMIT)));
  }
  return out;
}

export function getOverviewStats(db: Db) {
  // Core ledger only — the live experiment keeps its own books (see getLiveStats).
  const trades = db.select().from(paperTrades).where(eq(paperTrades.track, "core")).all();
  const open = trades.filter((t) => t.status === "open");
  // "closed" = exit copied from the wallet's SELL; realized like a resolution.
  const resolved = trades.filter((t) => t.status !== "open");
  const realized = resolved.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealized = open.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const wins = resolved.filter((t) => (t.realizedPnl ?? 0) > 0).length;

  const tracked = db.select().from(walletProfiles).where(eq(walletProfiles.status, "track")).all();

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todaysDecisions = db
    .select()
    .from(decisionJournal)
    .where(gte(decisionJournal.createdAt, dayStart))
    .all();

  const latestReport = db.select().from(dailyReports).orderBy(desc(dailyReports.date)).limit(1).get();
  const latestChanges = db.select().from(ruleChanges).orderBy(desc(ruleChanges.createdAt)).limit(5).all();
  const activeRuleSet = db.select().from(ruleSets).where(eq(ruleSets.active, true)).get();

  return {
    totalPaperPnl: realized + unrealized,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    winRate: resolved.length ? wins / resolved.length : null,
    resolvedCount: resolved.length,
    openPositions: open,
    trackedWallets: tracked.length,
    copyCandidatesToday: todaysDecisions.filter((d) => d.decision === "paper_copy").length,
    signalsToday: todaysDecisions.length,
    latestReport,
    latestChanges,
    activeRuleVersion: activeRuleSet?.version ?? null,
  };
}

/** Cumulative paper PnL series from pnl snapshots + resolutions (for the chart). */
export function getPnlSeries(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" | "elite" = "core"): { t: number; pnl: number }[] {
  const snaps = db
    .select({
      paperTradeId: pnlSnapshots.paperTradeId,
      pnl: pnlSnapshots.pnl,
      collectedAt: pnlSnapshots.collectedAt,
    })
    .from(pnlSnapshots)
    .innerJoin(paperTrades, eq(pnlSnapshots.paperTradeId, paperTrades.id))
    .where(eq(paperTrades.track, track))
    .orderBy(pnlSnapshots.collectedAt)
    .all();
  if (snaps.length === 0) return [];
  // At each snapshot time, total pnl = sum of the latest snapshot per trade up to that time.
  const latest = new Map<string, number>();
  const series: { t: number; pnl: number }[] = [];
  for (const s of snaps) {
    latest.set(s.paperTradeId, s.pnl);
    let total = 0;
    for (const v of latest.values()) total += v;
    series.push({ t: s.collectedAt.getTime(), pnl: Math.round(total * 100) / 100 });
  }
  return series;
}

/**
 * Cumulative REALIZED (settled) PnL series: steps only when a trade actually
 * resolves or is exit-closed — the honest scorecard, free of the open-position
 * mark-to-market noise that dominates getPnlSeries.
 */
export function getRealizedPnlSeries(
  db: Db,
  track: "core" | "live" | "trade" | "crypto" | "combo" | "elite" = "core",
  opts?: { openedSinceMs?: number },
): { t: number; pnl: number }[] {
  // openedSinceMs: start the curve at a strategy's own beginning. La Crema's
  // ledger holds a retired design AND the current hybrid; plotting them as one
  // line makes the live strategy look like it is $150 underwater when it is
  // actually a two-day-old experiment starting from zero.
  const conds = [eq(paperTrades.track, track), ne(paperTrades.status, "open")];
  if (opts?.openedSinceMs != null) conds.push(gte(paperTrades.openedAt, new Date(opts.openedSinceMs)));
  const settled = db
    .select({
      realizedPnl: paperTrades.realizedPnl,
      resolvedAt: paperTrades.resolvedAt,
      closedAt: paperTrades.closedAt,
    })
    .from(paperTrades)
    .where(and(...conds))
    .all();
  const events = settled
    .map((t) => ({ t: (t.resolvedAt ?? t.closedAt)?.getTime() ?? null, pnl: t.realizedPnl ?? 0 }))
    .filter((e): e is { t: number; pnl: number } => e.t !== null)
    .sort((a, b) => a.t - b.t);
  let cum = 0;
  return events.map((e) => {
    cum += e.pnl;
    return { t: e.t, pnl: Math.round(cum * 100) / 100 };
  });
}

/** Build decision-outcome rows for benchmark comparisons. */
export function getDecisionOutcomes(db: Db): DecisionOutcomeRow[] {
  const decisions = db.select().from(decisionJournal).all();
  if (decisions.length === 0) return [];
  const trades = db.select().from(paperTrades).where(eq(paperTrades.track, "core")).all();
  const tradeByDecision = new Map(trades.map((t) => [t.decisionJournalId, t]));
  const reviews = db.select().from(outcomeReviews).all();
  const reviewByDecision = new Map(reviews.map((r) => [r.decisionJournalId, r]));
  const observedIds = decisions.map((d) => d.observedTradeId);
  const observed = selectByIdsChunked(observedIds, (batch) =>
    db.select().from(observedTrades).where(inArray(observedTrades.id, batch)).all(),
  );
  const observedById = new Map(observed.map((o) => [o.id, o]));

  return decisions.map((d) => {
    const paper = tradeByDecision.get(d.id);
    const review = reviewByDecision.get(d.id);
    const obs = observedById.get(d.observedTradeId);

    const paperRealized = paper !== undefined && paper.status !== "open"; // resolved or exit-copied close
    const resolved = Boolean(paperRealized || (review && review.finalOutcome && review.finalOutcome !== "pending"));
    const paperPnl = paperRealized ? (paper.realizedPnl ?? null) : null;

    let hypo: number | null = null;
    const entry = obs?.detectedPrice ?? obs?.walletEntryPrice ?? null;
    if (entry !== null && review) {
      if (review.finalOutcome === "won") hypo = hypotheticalPnl(entry, 1);
      else if (review.finalOutcome === "lost") hypo = hypotheticalPnl(entry, 0);
      else if (review.priceAfter24h !== null) hypo = hypotheticalPnl(entry, review.priceAfter24h);
    }

    return {
      decision: d.decision,
      paperPnl,
      hypotheticalPnl: hypo,
      resolved,
    };
  });
}

export function getBenchmarkSummary(db: Db) {
  return computeBenchmarks(getDecisionOutcomes(db));
}

/**
 * Skip autopsy: for every non-copied signal, pair its blocking gate with what
 * it WOULD have earned (hypothetical $10 to its known outcome). Groups by gate
 * so we can see which filter leaks the most profit. Only signals with a known
 * outcome (via outcome_reviews) contribute to the $ figures.
 */
export function getSkipAutopsy(db: Db) {
  const decisions = db
    .select({
      id: decisionJournal.id,
      decision: decisionJournal.decision,
      blockedGate: decisionJournal.blockedGate,
      observedTradeId: decisionJournal.observedTradeId,
    })
    .from(decisionJournal)
    .where(ne(decisionJournal.decision, "paper_copy"))
    .all();
  if (decisions.length === 0) return { gates: [], reviewedSignals: 0, labeledSignals: 0 };

  const reviews = db.select().from(outcomeReviews).all();
  const reviewByDecision = new Map(reviews.map((r) => [r.decisionJournalId, r]));
  const observedIds = decisions.map((d) => d.observedTradeId);
  const observed = selectByIdsChunked(observedIds, (batch) =>
    db.select().from(observedTrades).where(inArray(observedTrades.id, batch)).all(),
  );
  const observedById = new Map(observed.map((o) => [o.id, o]));

  let reviewedSignals = 0; // signals that actually feed the table: gate + known outcome
  let labeledSignals = 0; // signals carrying a gate label (regardless of outcome yet)
  const rows = decisions.map((d) => {
    const review = reviewByDecision.get(d.id);
    const obs = observedById.get(d.observedTradeId);
    const entry = obs?.detectedPrice ?? obs?.walletEntryPrice ?? null;
    let hypo: number | null = null;
    if (entry !== null && review) {
      if (review.finalOutcome === "won") hypo = hypotheticalPnl(entry, 1);
      else if (review.finalOutcome === "lost") hypo = hypotheticalPnl(entry, 0);
      else if (review.priceAfter24h !== null) hypo = hypotheticalPnl(entry, review.priceAfter24h);
    }
    // Only gate-labeled signals with a known outcome are usable. Older rows
    // (pre blocked_gate) resolve but have no gate; freshly-labeled ones have a
    // gate but haven't resolved yet — neither counts as usable evidence.
    if (d.blockedGate) {
      labeledSignals++;
      if (hypo !== null) reviewedSignals++;
    }
    return { blockedGate: d.blockedGate, hypotheticalPnl: hypo };
  });

  return { gates: computeSkipAutopsy(rows), reviewedSignals, labeledSignals };
}

/** Latest market snapshot per market id. */
export function getLatestSnapshots(db: Db, marketIds: string[]) {
  if (marketIds.length === 0) return new Map<string, typeof marketSnapshots.$inferSelect>();
  const rows = db
    .select()
    .from(marketSnapshots)
    .where(inArray(marketSnapshots.marketId, marketIds))
    .orderBy(desc(marketSnapshots.collectedAt))
    .all();
  const map = new Map<string, typeof marketSnapshots.$inferSelect>();
  for (const r of rows) if (!map.has(r.marketId)) map.set(r.marketId, r);
  return map;
}

/** Per-wallet paper performance (realized + unrealized) for a given ledger. */
export function getWalletPaperPerformance(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" | "elite" = "core") {
  const rows = db
    .select({
      walletAddress: paperTrades.walletAddress,
      realized: sql<number>`coalesce(sum(${paperTrades.realizedPnl}), 0)`,
      unrealized: sql<number>`coalesce(sum(${paperTrades.unrealizedPnl}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(paperTrades)
    .where(eq(paperTrades.track, track))
    .groupBy(paperTrades.walletAddress)
    .all();
  return rows.map((r) => ({
    walletAddress: r.walletAddress,
    totalPnl: Math.round((r.realized + r.unrealized) * 100) / 100,
    tradeCount: r.count,
  }));
}

/**
 * Ledger comparison: the LIVE experiment (track='live', in-play copies) vs the
 * CORE strategy (track='core', pre-game copies). Two separate books — each
 * one does its own thing; the numbers are never mixed elsewhere.
 */
export function getInPlayPaperPerformance(db: Db) {
  const rows = db
    .select({
      track: paperTrades.track,
      status: paperTrades.status,
      realizedPnl: paperTrades.realizedPnl,
      unrealizedPnl: paperTrades.unrealizedPnl,
    })
    .from(paperTrades)
    .all();

  const empty = () => ({ count: 0, resolvedCount: 0, wins: 0, totalPnl: 0 });
  const groups = { live: empty(), preGame: empty() };
  for (const r of rows) {
    if (r.track !== "live" && r.track !== "core") continue; // 'trade' book has its own page
    const g = r.track === "live" ? groups.live : groups.preGame;
    g.count++;
    g.totalPnl += r.realizedPnl ?? r.unrealizedPnl ?? 0;
    if (r.status !== "open") {
      g.resolvedCount++;
      if ((r.realizedPnl ?? 0) > 0) g.wins++;
    }
  }
  const finish = (g: ReturnType<typeof empty>) => ({
    count: g.count,
    resolvedCount: g.resolvedCount,
    winRate: g.resolvedCount ? g.wins / g.resolvedCount : null,
    totalPnl: Math.round(g.totalPnl * 100) / 100,
    avgPnl: g.resolvedCount ? Math.round((g.totalPnl / g.resolvedCount) * 100) / 100 : null,
  });
  return { live: finish(groups.live), preGame: finish(groups.preGame) };
}

/** Everything the ⚡ En Vivo page needs — live ledger only, never core. */
export function getLiveStats(db: Db) {
  const trades = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.track, "live"))
    .orderBy(desc(paperTrades.openedAt))
    .all();
  const open = trades.filter((t) => t.status === "open");
  const resolved = trades.filter((t) => t.status !== "open"); // resolved or exit-copied close
  const realized = resolved.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealized = open.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const wins = resolved.filter((t) => (t.realizedPnl ?? 0) > 0).length;

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const liveSignalsToday = db
    .select({ id: observedTrades.id })
    .from(observedTrades)
    .where(and(eq(observedTrades.inPlay, true), gte(observedTrades.timestamp, dayStart)))
    .all().length;

  const liveSignals = db
    .select()
    .from(observedTrades)
    .where(eq(observedTrades.inPlay, true))
    .orderBy(desc(observedTrades.timestamp))
    .limit(50)
    .all();

  // Wallets with a real live-betting record (min sample), best live win rate first.
  const liveWallets = db
    .select()
    .from(walletProfiles)
    .where(gte(walletProfiles.liveResolvedCount30d, 5))
    .orderBy(desc(walletProfiles.liveWinRate30d))
    .limit(10)
    .all();

  // The live experiment's own self-improving rule set.
  const liveRuleSet = db
    .select()
    .from(ruleSets)
    .where(and(eq(ruleSets.active, true), eq(ruleSets.scope, "live")))
    .get();
  const liveRuleChanges = db
    .select()
    .from(ruleChanges)
    .where(eq(ruleChanges.scope, "live"))
    .orderBy(desc(ruleChanges.createdAt))
    .limit(5)
    .all();

  return {
    trades,
    openCount: open.length,
    resolvedCount: resolved.length,
    totalPnl: Math.round((realized + unrealized) * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    winRate: resolved.length ? wins / resolved.length : null,
    liveSignalsToday,
    liveSignals,
    liveWallets,
    liveRuleVersion: liveRuleSet?.version ?? null,
    liveRuleChanges,
  };
}

/** Everything the 🔁 Trade page needs — trade ledger only, never core/live. */
export function getTradeStats(db: Db) {
  const trades = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.track, "trade"))
    .orderBy(desc(paperTrades.openedAt))
    .all();
  const open = trades.filter((t) => t.status === "open");
  const settled = trades.filter((t) => t.status !== "open"); // resolved or exit-closed
  const realized = settled.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealized = open.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  // How many settled scalps closed early (exit copied) vs rode to resolution.
  const exitClosed = settled.filter((t) => t.status === "closed").length;

  // Quota-trader wallets that feed this book: profiled as odds-traders with
  // positive swing PnL, best swing win rate first.
  const quotaWallets = db
    .select()
    .from(walletProfiles)
    .where(
      and(
        inArray(walletProfiles.tradingStyle, ["tradea_cuota", "mixto"]),
        gte(walletProfiles.swingPnl30d, 0.01),
      ),
    )
    .orderBy(desc(walletProfiles.swingWinRate30d))
    .limit(15)
    .all();

  const tradeRuleSet = db
    .select()
    .from(ruleSets)
    .where(and(eq(ruleSets.active, true), eq(ruleSets.scope, "trade")))
    .get();
  const tradeRuleChanges = db
    .select()
    .from(ruleChanges)
    .where(eq(ruleChanges.scope, "trade"))
    .orderBy(desc(ruleChanges.createdAt))
    .limit(5)
    .all();

  return {
    trades,
    openCount: open.length,
    settledCount: settled.length,
    exitClosed,
    totalPnl: Math.round((realized + unrealized) * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    winRate: settled.length ? wins / settled.length : null,
    quotaWallets,
    tradeRuleVersion: tradeRuleSet?.version ?? null,
    tradeRuleChanges,
  };
}

/**
 * Funnel diagnostic for the ₿ Cripto book — answers WHERE the pipeline dies.
 *
 * Built 2026-07-16 after the third consecutive AI cut reported 0 settled /
 * 0 open ("ya no es timing, es pipeline"). Each stage counts the wallets or
 * signals that survive one more gate, so a zero pinpoints the broken stage
 * instead of guessing:
 *
 *   mined -> profiled -> tracked -> eligible          (wallet side)
 *   signals 7d -> BUYs -> BUYs inside the entry band  (signal side)
 *
 * The suspected gap: only status="track" wallets are monitored at all, but
 * crypto scalpers round-trip instead of holding to resolution, so their
 * HOLDER score can stay under the tracking threshold even when they pass
 * isCryptoBookEligible — eligible for the book, invisible to the monitor.
 * `eligibleNotTracked` counts exactly those wallets.
 */
export function getCryptoFunnel(db: Db) {
  const { rules: cryptoRules } = getActiveRules(db, "crypto");

  const mined = db
    .select()
    .from(walletProfiles)
    .where(like(walletProfiles.sources, "%crypto-market%"))
    .all();
  const profiled = mined.filter((w) => w.lastScannedAt != null);
  const tracked = profiled.filter((w) => w.status === "track");
  const eligible = profiled.filter((w) => isCryptoBookEligible(w, cryptoRules.minWalletGlobalScore));
  const eligibleNotTracked = eligible.filter((w) => w.status !== "track");

  // Signal side: what did the monitor actually SEE from these wallets lately?
  // (Only tracked wallets are monitored, so this reflects real visibility.)
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const signals = selectByIdsChunked(mined.map((w) => w.address), (batch) =>
    db
      .select({
        side: observedTrades.side,
        detectedPrice: observedTrades.detectedPrice,
        walletEntryPrice: observedTrades.walletEntryPrice,
      })
      .from(observedTrades)
      .where(and(inArray(observedTrades.walletAddress, batch), gte(observedTrades.timestamp, since)))
      .all(),
  );
  const buys = signals.filter((s) => s.side === "BUY");
  const buysInBand = buys.filter((s) => {
    const p = s.detectedPrice ?? s.walletEntryPrice;
    return p >= cryptoRules.minEntryPrice && p <= cryptoRules.maxEntryPrice;
  });

  return {
    minedCount: mined.length,
    profiledCount: profiled.length,
    trackedCount: tracked.length,
    eligibleCount: eligible.length,
    eligibleNotTrackedCount: eligibleNotTracked.length,
    signals7d: signals.length,
    buys7d: buys.length,
    buysInBand7d: buysInBand.length,
    band: { min: cryptoRules.minEntryPrice, max: cryptoRules.maxEntryPrice },
    minScore: cryptoRules.minWalletGlobalScore,
  };
}

/** Everything the ₿ Cripto book needs — crypto ledger only, never core/live/trade. */
export function getCryptoBookStats(db: Db) {
  const trades = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.track, "crypto"))
    .orderBy(desc(paperTrades.openedAt))
    .all();
  const open = trades.filter((t) => t.status === "open");
  const settled = trades.filter((t) => t.status !== "open"); // resolved or exit-closed
  const realized = settled.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealized = open.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const exitClosed = settled.filter((t) => t.status === "closed").length;

  // Crypto-sourced wallets that feed this book (mined off the "Crypto" tag).
  const cryptoWallets = db
    .select()
    .from(walletProfiles)
    .where(like(walletProfiles.sources, "%crypto-market%"))
    .orderBy(desc(walletProfiles.globalScore))
    .limit(15)
    .all();

  const cryptoRuleSet = db
    .select()
    .from(ruleSets)
    .where(and(eq(ruleSets.active, true), eq(ruleSets.scope, "crypto")))
    .get();
  const cryptoRuleChanges = db
    .select()
    .from(ruleChanges)
    .where(eq(ruleChanges.scope, "crypto"))
    .orderBy(desc(ruleChanges.createdAt))
    .limit(5)
    .all();

  return {
    trades,
    openCount: open.length,
    settledCount: settled.length,
    exitClosed,
    totalPnl: Math.round((realized + unrealized) * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    winRate: settled.length ? wins / settled.length : null,
    cryptoWallets,
    cryptoRuleVersion: cryptoRuleSet?.version ?? null,
    cryptoRuleChanges,
  };
}

/**
 * Diagnostics for the last Combo Cup leaderboard scrape: did it work from this
 * host? Cloudflare challenges polymarket.com's web frontend from some
 * datacenter IPs (the JSON APIs answer fine), so this surfaces whether the
 * scrape is returning rows or being blocked. null until the scan runs once.
 */
export function getComboScanStatus(db: Db) {
  const row = db
    .select()
    .from(leaderboardScans)
    .where(eq(leaderboardScans.source, "combo-cup"))
    .orderBy(desc(leaderboardScans.scannedAt))
    .limit(1)
    .get();
  if (!row) return null;
  let detail: {
    periods?: Record<string, { rows: number } | { error: string }>;
    resolved?: number;
    unresolved?: number;
    profileFetches?: number;
    created?: number;
    updated?: number;
  } = {};
  try {
    detail = JSON.parse(row.rawSummaryJson);
  } catch {
    detail = {};
  }
  const periods = detail.periods ?? {};
  const totalRows = Object.values(periods).reduce((a, p) => a + ("rows" in p ? p.rows : 0), 0);
  const errors = Object.entries(periods)
    .filter(([, p]) => "error" in p)
    .map(([name, p]) => `${name}: ${(p as { error: string }).error}`);
  // Blocked = the scrape returned zero usable rows across every period (a
  // Cloudflare challenge parses to 0 rows, which fetchComboLeaderboard reports
  // as an error). Working = at least one period returned rows.
  const ok = totalRows > 0;
  return {
    scannedAt: row.scannedAt,
    walletCount: row.walletCount,
    totalRows,
    ok,
    errors,
    resolved: detail.resolved ?? row.walletCount,
    unresolved: detail.unresolved ?? 0,
  };
}

/**
 * Everything the 🏆 Elite book ("la crema") needs. Elite has no rules of its
 * own — it mirrors whichever arm (core/live/trade/crypto) already decided to
 * copy a trade, filtered to that arm's current weekly top-10. This returns
 * both the mirrored ledger AND the current roster per arm, so the page can
 * show WHO qualifies right now, not just what got copied.
 */
export function getEliteBookStats(db: Db) {
  const trades = db.select().from(paperTrades).where(eq(paperTrades.track, "elite")).orderBy(desc(paperTrades.openedAt)).all();
  const open = trades.filter((t) => t.status === "open");
  const settled = trades.filter((t) => t.status !== "open");
  const realized = settled.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealized = open.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) > 0).length;

  const roster = db.select().from(eliteRoster).orderBy(eliteRoster.arm, eliteRoster.rank).all();
  const rosterByArm = new Map<string, typeof roster>();
  for (const r of roster) rosterByArm.set(r.arm, [...(rosterByArm.get(r.arm) ?? []), r]);
  const lastRefreshedAt = roster.length ? roster.reduce((a, r) => (r.computedAt > a ? r.computedAt : a), roster[0].computedAt) : null;

  // Two different experiments live in this one ledger. Judging the matrix-driven
  // design by the combined number is judging it by the failed top-10-wallet
  // design's hole — which is what every AI cut has been doing ("Elite failed").
  // goldRule is the separator: only the new design stamps it.
  const summarize = (rs: typeof trades) => {
    const s = rs.filter((t) => t.status !== "open");
    const o = rs.filter((t) => t.status === "open");
    const r = s.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
    const u = o.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
    const w = s.filter((t) => (t.realizedPnl ?? 0) > 0).length;
    return {
      count: rs.length,
      settledCount: s.length,
      openCount: o.length,
      realizedPnl: Math.round(r * 100) / 100,
      unrealizedPnl: Math.round(u * 100) / 100,
      totalPnl: Math.round((r + u) * 100) / 100,
      winRate: s.length ? w / s.length : null,
    };
  };

  const legacy = summarize(trades.filter((t) => !t.goldRule));
  const matrixDriven = summarize(trades.filter((t) => t.goldRule));
  // Group by CANONICAL cell id: pre-engine stamps ("mañana") and engine stamps
  // ("hour:08") are the same cell and must land on the same pruning-board row.
  const byRule = new Map<string, ReturnType<typeof summarize>>();
  for (const rule of new Set(trades.map((t) => (t.goldRule ? canonicalGoldRule(t.goldRule) : null)).filter(Boolean) as string[])) {
    byRule.set(rule, summarize(trades.filter((t) => t.goldRule && canonicalGoldRule(t.goldRule) === rule)));
  }

  return {
    trades,
    openCount: open.length,
    settledCount: settled.length,
    totalPnl: Math.round((realized + unrealized) * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    winRate: settled.length ? wins / settled.length : null,
    legacy,
    matrixDriven,
    byRule,
    roster,
    rosterByArm,
    rosterSize: roster.length,
    lastRefreshedAt,
  };
}

/**
 * 🧬 La Crema's self-evolving cell state for /elite: every tracked cell
 * (active gold, active traps, candidatas, retiradas) plus the recent diary.
 * Tolerates a pre-migration DB by returning empty sets, never throwing.
 */
export function getCremaCellsOverview(db: Db) {
  try {
    const cells = loadAllCells(db);
    const events = db.select().from(cremaEvolution).orderBy(desc(cremaEvolution.at)).limit(30).all();
    // Exploratory copies are booked apart: the price of learning must never be
    // read as the strategy's own performance.
    const explore = db
      .select({
        n: sql<number>`count(*)`,
        pnl: sql<number>`coalesce(sum(${paperTrades.realizedPnl}), 0)`,
        staked: sql<number>`coalesce(sum(${paperTrades.simulatedPositionSize}), 0)`,
      })
      .from(paperTrades)
      .where(and(eq(paperTrades.track, "elite"), eq(paperTrades.exploratory, true)))
      .get();
    return {
      activeGold: cells.filter((c) => c.kind === "gold" && c.status === "activa"),
      activeTraps: cells.filter((c) => c.kind === "trap" && c.status === "activa"),
      candidatas: cells.filter((c) => c.status === "candidata"),
      // 👻 Nominated by the shadow book (declined signals), awaiting real fills.
      sospechas: cells.filter((c) => c.status === "sospecha"),
      retiradas: cells.filter((c) => c.status === "retirada"),
      exploration: {
        n: explore?.n ?? 0,
        pnl: explore?.pnl ?? 0,
        roi: explore && explore.staked > 0 ? explore.pnl / explore.staked : null,
      },
      events,
    };
  } catch {
    return {
      activeGold: [],
      activeTraps: [],
      candidatas: [],
      sospechas: [],
      retiradas: [],
      exploration: { n: 0, pnl: 0, roi: null },
      events: [],
    };
  }
}

/**
 * 🎯 The daily pick record. Returns EVERY pick ever published, losers included —
 * the whole value of the page is that nothing can be dropped after the fact.
 */
export function getDailyPicks(db: Db) {
  try {
    const picks = db
      .select()
      .from(dailyPicks)
      .orderBy(desc(dailyPicks.pickDate), dailyPicks.rank)
      .all();
    // The official record is rank 1 ONLY. Scoring all four together would turn
    // it into "at least one of our picks won" — the oldest tipster trick there is.
    return {
      picks,
      record: summarizeRecord(picks.filter((p) => p.rank === 1)),
      alternatesRecord: summarizeRecord(picks.filter((p) => p.rank !== 1)),
      days: byCalendarDay(picks, dayKeyTz(new Date())),
    };
  } catch {
    return { picks: [], record: summarizeRecord([]), alternatesRecord: summarizeRecord([]), days: [] };
  }
}

/**
 * 📏 Depth study: per-size fill quality, overall and split by category.
 *
 * Only trades opened after the ladder instrument shipped carry data, so the
 * sample starts empty and grows. Returning an honest empty report (rather than
 * inventing numbers) is what lets the page say "still collecting".
 */
export function getDepthStudy(db: Db) {
  try {
    const rows = db
      .select({
        entryPrice: paperTrades.entryPrice,
        marketQuestion: paperTrades.marketQuestion,
        depthLadderJson: paperTrades.depthLadderJson,
        openedAt: paperTrades.openedAt,
      })
      .from(paperTrades)
      .where(ne(paperTrades.track, "elite"))
      .all();

    const inputs: { ladder: NonNullable<ReturnType<typeof parseLadder>>; entryPrice: number; category: CategoryKey }[] = [];
    for (const r of rows) {
      const ladder = parseLadder(r.depthLadderJson);
      if (!ladder) continue;
      inputs.push({ ladder, entryPrice: r.entryPrice, category: categorizeMarket(r.marketQuestion) });
    }

    const byCategory = new Map<CategoryKey, typeof inputs>();
    for (const i of inputs) {
      const list = byCategory.get(i.category) ?? [];
      list.push(i);
      byCategory.set(i.category, list);
    }

    // The band the strategy actually trades — depth there is what decides
    // whether a bigger stake is viable, so it gets measured on its own.
    const sweet = inputs.filter((i) => i.entryPrice >= 0.55 && i.entryPrice < 0.6);

    const firstAt = rows
      .filter((r) => r.depthLadderJson)
      .reduce<Date | null>((min, r) => (!min || r.openedAt < min ? r.openedAt : min), null);

    return {
      overall: analyzeDepth(inputs),
      sweetBand: analyzeDepth(sweet),
      byCategory: [...byCategory.entries()]
        .map(([category, list]) => ({ category, report: analyzeDepth(list) }))
        .filter((c) => c.report.sampleSize >= 5)
        .sort((a, b) => b.report.sampleSize - a.report.sampleSize),
      collectingSince: firstAt,
      broken: null as string | null,
    };
  } catch (err) {
    // "No data yet" and "the instrument is broken" look identical from the
    // outside, and quietly rendering the first when it is the second is how a
    // dashboard starts lying. Surface the failure instead.
    return {
      overall: analyzeDepth([]),
      sweetBand: analyzeDepth([]),
      byCategory: [],
      collectingSince: null,
      broken: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 💰 Capital book: the constrained bankroll, its curve, and the funnel of what
 * it had to turn away. The skip counts are not a footnote — they are how you
 * tell "the strategy is good" from "the rules let us trade the strategy".
 */
export function getCapitalBook(db: Db, variant: string = "c3") {
  try {
    const rows = db
      .select()
      .from(capitalBook)
      .where(eq(capitalBook.variant, variant))
      .orderBy(desc(capitalBook.openedAt))
      .all();
    const taken = rows.filter((r) => r.status !== "skipped");
    const skipped = rows.filter((r) => r.status === "skipped");
    const settledRows = taken.filter((r) => r.realizedPnl !== null);
    const open = taken.filter((r) => r.status === "open");

    const realized = settledRows.reduce((s, r) => s + (r.realizedPnl ?? 0), 0);
    const wins = settledRows.filter((r) => (r.realizedPnl ?? 0) > 0).length;
    const capital = CAPITAL_START + realized;
    const committed = open.length * FLAT_STAKE;

    const skipReasons = new Map<string, number>();
    for (const s of skipped) {
      const k = s.skipReason ?? "desconocido";
      skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
    }

    // Does agreement between arms predict a better result? Only answerable once
    // the confluent positions settle, so it is reported as it fills in.
    const confluent = settledRows.filter((r) => r.armConfluence > 1);
    const solo = settledRows.filter((r) => r.armConfluence <= 1);
    const roiOf = (list: typeof settledRows) =>
      list.length ? list.reduce((s, r) => s + (r.realizedPnl ?? 0), 0) / (list.length * FLAT_STAKE) : null;

    const slippages = taken
      .map((r) => r.slippageCents)
      .filter((s): s is number => s !== null)
      .sort((a, b) => a - b);

    return {
      variant,
      rows,
      open,
      settled: settledRows,
      capital,
      committed,
      freeCapital: capital - committed,
      realized,
      roi: settledRows.length ? realized / (settledRows.length * FLAT_STAKE) : null,
      winRate: settledRows.length ? wins / settledRows.length : null,
      settledCount: settledRows.length,
      takenCount: taken.length,
      skippedCount: skipped.length,
      seenCount: rows.length,
      skipReasons: [...skipReasons.entries()].sort((a, b) => b[1] - a[1]),
      medianSlippageCents: slippages.length ? slippages[Math.floor(slippages.length / 2)] : null,
      confluence: {
        count: confluent.length,
        roi: roiOf(confluent),
        soloCount: solo.length,
        soloRoi: roiOf(solo),
      },
      startedAt: rows.length ? rows[rows.length - 1].openedAt : null,
      broken: null as string | null,
    };
  } catch (err) {
    return {
      variant, rows: [], open: [], settled: [], capital: CAPITAL_START, committed: 0,
      freeCapital: CAPITAL_START, realized: 0, roi: null, winRate: null,
      settledCount: 0, takenCount: 0, skippedCount: 0, seenCount: 0,
      skipReasons: [] as [string, number][], medianSlippageCents: null,
      confluence: { count: 0, roi: null, soloCount: 0, soloRoi: null },
      startedAt: null,
      broken: err instanceof Error ? err.message : String(err),
    };
  }
}

export type CapitalBookView = ReturnType<typeof getCapitalBook>;

/**
 * ⚡ Fast book: forward-test of the duration finding — see fastBook.ts. Same
 * shape as getCapitalBook, minus the 3-vs-5 variant split (this book only
 * runs one policy for now).
 */
export function getFastBook(db: Db) {
  try {
    const rows = db.select().from(fastBook).orderBy(desc(fastBook.openedAt)).all();
    const taken = rows.filter((r) => r.status !== "skipped");
    const skipped = rows.filter((r) => r.status === "skipped");
    const settledRows = taken.filter((r) => r.realizedPnl !== null);
    const open = taken.filter((r) => r.status === "open");

    const realized = settledRows.reduce((s, r) => s + (r.realizedPnl ?? 0), 0);
    const wins = settledRows.filter((r) => (r.realizedPnl ?? 0) > 0).length;
    const capital = CAPITAL_START + realized;
    const committed = open.length * FLAT_STAKE;

    const skipReasons = new Map<string, number>();
    for (const s of skipped) {
      const k = s.skipReason ?? "desconocido";
      skipReasons.set(k, (skipReasons.get(k) ?? 0) + 1);
    }

    const exitReasons = new Map<string, number>();
    for (const s of settledRows) {
      const k = s.exitReason ?? "desconocido";
      exitReasons.set(k, (exitReasons.get(k) ?? 0) + 1);
    }

    const confluent = settledRows.filter((r) => r.armConfluence > 1);
    const solo = settledRows.filter((r) => r.armConfluence <= 1);
    const roiOf = (list: typeof settledRows) =>
      list.length ? list.reduce((s, r) => s + (r.realizedPnl ?? 0), 0) / (list.length * FLAT_STAKE) : null;

    const slippages = taken
      .map((r) => r.slippageCents)
      .filter((s): s is number => s !== null)
      .sort((a, b) => a - b);

    const byCategory = new Map<string, { n: number; pnl: number; wins: number }>();
    for (const r of settledRows) {
      const k = r.category ?? "otros";
      const acc = byCategory.get(k) ?? { n: 0, pnl: 0, wins: 0 };
      acc.n += 1;
      acc.pnl += r.realizedPnl ?? 0;
      if ((r.realizedPnl ?? 0) > 0) acc.wins += 1;
      byCategory.set(k, acc);
    }

    return {
      rows,
      open,
      settled: settledRows,
      capital,
      committed,
      freeCapital: capital - committed,
      realized,
      roi: settledRows.length ? realized / (settledRows.length * FLAT_STAKE) : null,
      winRate: settledRows.length ? wins / settledRows.length : null,
      settledCount: settledRows.length,
      takenCount: taken.length,
      skippedCount: skipped.length,
      seenCount: rows.length,
      skipReasons: [...skipReasons.entries()].sort((a, b) => b[1] - a[1]),
      exitReasons: [...exitReasons.entries()].sort((a, b) => b[1] - a[1]),
      medianSlippageCents: slippages.length ? slippages[Math.floor(slippages.length / 2)] : null,
      confluence: {
        count: confluent.length,
        roi: roiOf(confluent),
        soloCount: solo.length,
        soloRoi: roiOf(solo),
      },
      byCategory: [...byCategory.entries()]
        .map(([category, v]) => ({
          category,
          n: v.n,
          pnl: v.pnl,
          winRate: v.n ? v.wins / v.n : null,
          roi: v.n ? v.pnl / (v.n * FLAT_STAKE) : null,
        }))
        .sort((a, b) => b.n - a.n),
      startedAt: rows.length ? rows[rows.length - 1].openedAt : null,
      broken: null as string | null,
    };
  } catch (err) {
    return {
      rows: [], open: [], settled: [], capital: CAPITAL_START, committed: 0,
      freeCapital: CAPITAL_START, realized: 0, roi: null, winRate: null,
      settledCount: 0, takenCount: 0, skippedCount: 0, seenCount: 0,
      skipReasons: [] as [string, number][], exitReasons: [] as [string, number][],
      medianSlippageCents: null,
      confluence: { count: 0, roi: null, soloCount: 0, soloRoi: null },
      byCategory: [] as { category: string; n: number; pnl: number; winRate: number | null; roi: number | null }[],
      startedAt: null,
      broken: err instanceof Error ? err.message : String(err),
    };
  }
}

export type FastBookView = ReturnType<typeof getFastBook>;

/** Everything the 🧩 Combo book needs — combo ledger only, never the others. */
export function getComboBookStats(db: Db) {
  const trades = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.track, "combo"))
    .orderBy(desc(paperTrades.openedAt))
    .all();
  const open = trades.filter((t) => t.status === "open");
  const settled = trades.filter((t) => t.status !== "open"); // resolved or cash-out closed
  const realized = settled.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const cashouts = settled.filter((t) => t.status === "closed").length;
  // Open combos cannot be marked (no public book) — capital at risk is the honest figure.
  const capitalAtRisk = open.reduce((a, t) => a + t.simulatedPositionSize, 0);

  // Combo-Cup wallets, best combo cashflow first.
  const comboWallets = db
    .select()
    .from(walletProfiles)
    .where(like(walletProfiles.sources, "%combo-cup%"))
    .orderBy(desc(walletProfiles.comboNetPnl30d))
    .limit(20)
    .all();
  const eligibleCount = comboWallets.filter(
    (w) => (w.comboNetPnl30d ?? 0) > 0 && (w.comboTradeCount30d ?? 0) >= 3 && !w.benched,
  ).length;
  const profiledCount = comboWallets.filter((w) => w.comboLastProfiledAt !== null).length;

  const comboRuleSet = db
    .select()
    .from(ruleSets)
    .where(and(eq(ruleSets.active, true), eq(ruleSets.scope, "combo")))
    .get();
  const comboRuleChanges = db
    .select()
    .from(ruleChanges)
    .where(eq(ruleChanges.scope, "combo"))
    .orderBy(desc(ruleChanges.createdAt))
    .limit(5)
    .all();

  return {
    trades,
    openCount: open.length,
    settledCount: settled.length,
    cashouts,
    capitalAtRisk: Math.round(capitalAtRisk * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    winRate: settled.length ? wins / settled.length : null,
    comboWallets,
    eligibleCount,
    profiledCount,
    comboRuleVersion: comboRuleSet?.version ?? null,
    comboRuleChanges,
  };
}

/**
 * Sourcing observation desk: wallets discovered by mining markets with a given
 * source tag ("crypto-market" or "fast-market"), plus their swing profile. An
 * observation feed, not a separate paper ledger; qualifying wallets flow into
 * the existing books. Shared by /cripto and /cazador.
 */
export function getSourcingDesk(db: Db, sourceTag: string) {
  const wallets = db
    .select()
    .from(walletProfiles)
    .where(like(walletProfiles.sources, `%${sourceTag}%`))
    .all();

  const profiled = wallets.filter((w) => w.lastScannedAt !== null);
  const pending = wallets.length - profiled.length;
  const tracked = profiled.filter((w) => w.status === "track");
  const quota = profiled.filter(
    (w) =>
      (w.tradingStyle === "tradea_cuota" || w.tradingStyle === "mixto") && (w.swingPnl30d ?? 0) > 0,
  );

  // Best crypto wallets first: quota-eligible on top, then by swing PnL / score.
  const ranked = [...profiled].sort((a, b) => {
    const sa = (b.swingPnl30d ?? 0) - (a.swingPnl30d ?? 0);
    if (sa !== 0) return sa;
    return (b.globalScore ?? 0) - (a.globalScore ?? 0);
  });

  // --- Paper-trade activity generated by THIS desk's wallets ---
  // These desks aren't a separate ledger; their discovered wallets feed the
  // existing books (core/live/trade). So the "trades it picked" are the paper
  // trades opened from those wallets, wherever they landed — shown with their
  // book, plus a PnL chart and a per-wallet ranking, like the live page.
  const addrs = wallets.map((w) => w.address);
  const trades = addrs.length
    ? db
        .select()
        .from(paperTrades)
        .where(inArray(paperTrades.walletAddress, addrs))
        .orderBy(desc(paperTrades.openedAt))
        .all()
    : [];

  const open = trades.filter((t) => t.status === "open");
  const settled = trades.filter((t) => t.status !== "open");
  const realizedPnl = settled.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealizedPnl = open.reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const wins = settled.filter((t) => (t.realizedPnl ?? 0) > 0).length;

  // Realized (settled) PnL series — the honest scorecard for these wallets.
  const realizedSeries = settled
    .map((t) => ({ t: (t.resolvedAt ?? t.closedAt)?.getTime() ?? null, pnl: t.realizedPnl ?? 0 }))
    .filter((e): e is { t: number; pnl: number } => e.t !== null)
    .sort((a, b) => a.t - b.t)
    .reduce<{ t: number; pnl: number }[]>((acc, e) => {
      const cum = (acc.length ? acc[acc.length - 1].pnl : 0) + e.pnl;
      acc.push({ t: e.t, pnl: Math.round(cum * 100) / 100 });
      return acc;
    }, []);

  // Marked (mark-to-market) series from snapshots of these wallets' trades.
  const snaps = addrs.length
    ? db
        .select({ paperTradeId: pnlSnapshots.paperTradeId, pnl: pnlSnapshots.pnl, collectedAt: pnlSnapshots.collectedAt })
        .from(pnlSnapshots)
        .innerJoin(paperTrades, eq(pnlSnapshots.paperTradeId, paperTrades.id))
        .where(inArray(paperTrades.walletAddress, addrs))
        .orderBy(pnlSnapshots.collectedAt)
        .all()
    : [];
  const latest = new Map<string, number>();
  const markedSeries: { t: number; pnl: number }[] = [];
  for (const s of snaps) {
    latest.set(s.paperTradeId, s.pnl);
    let total = 0;
    for (const v of latest.values()) total += v;
    markedSeries.push({ t: s.collectedAt.getTime(), pnl: Math.round(total * 100) / 100 });
  }

  // Per-wallet ranking by realized+unrealized PnL among this desk's trades.
  const perByWallet = new Map<string, { walletAddress: string; tradeCount: number; totalPnl: number }>();
  for (const t of trades) {
    const cur = perByWallet.get(t.walletAddress) ?? { walletAddress: t.walletAddress, tradeCount: 0, totalPnl: 0 };
    cur.tradeCount += 1;
    cur.totalPnl += (t.status !== "open" ? t.realizedPnl : t.unrealizedPnl) ?? 0;
    perByWallet.set(t.walletAddress, cur);
  }
  const byWallet = [...perByWallet.values()]
    .map((w) => ({ ...w, totalPnl: Math.round(w.totalPnl * 100) / 100 }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  return {
    total: wallets.length,
    profiledCount: profiled.length,
    pendingCount: pending,
    trackedCount: tracked.length,
    quotaCount: quota.length,
    wallets: ranked.slice(0, 40),
    // activity
    tradeCount: trades.length,
    openCount: open.length,
    settledCount: settled.length,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    totalPnl: Math.round((realizedPnl + unrealizedPnl) * 100) / 100,
    winRate: settled.length ? wins / settled.length : null,
    realizedSeries,
    markedSeries,
    trades: trades.slice(0, 40),
    byWallet: byWallet.slice(0, 15),
  };
}

/**
 * Daily REALIZED PnL per book (core/live/trade/crypto). The honest "how much did
 * the system generate each day" scorecard: buckets every settled paper trade by
 * its settle day (in the project timezone, UTC-4) and its ledger. Realized only
 * — open positions' mark-to-market isn't money generated yet. Newest day first.
 */
export function getDailyPnlByBook(db: Db) {
  const tracks = ["core", "live", "trade", "crypto", "combo", "elite"] as const;
  const settled = db
    .select({
      track: paperTrades.track,
      realizedPnl: paperTrades.realizedPnl,
      resolvedAt: paperTrades.resolvedAt,
      closedAt: paperTrades.closedAt,
    })
    .from(paperTrades)
    .where(ne(paperTrades.status, "open"))
    .all();

  type Cell = { pnl: number; count: number };
  const byDay = new Map<string, Record<string, Cell>>();
  for (const t of settled) {
    const settleAt = t.resolvedAt ?? t.closedAt;
    if (!settleAt) continue;
    const day = dayKeyTz(settleAt);
    const row = byDay.get(day) ?? {};
    const cell = row[t.track] ?? { pnl: 0, count: 0 };
    cell.pnl += t.realizedPnl ?? 0;
    cell.count += 1;
    row[t.track] = cell;
    byDay.set(day, row);
  }

  const round = (x: number) => Math.round(x * 100) / 100;
  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest first
    .map(([day, row]) => {
      const byTrack: Record<string, Cell> = {};
      let total = 0;
      let totalCount = 0;
      for (const tr of tracks) {
        const c = row[tr] ?? { pnl: 0, count: 0 };
        byTrack[tr] = { pnl: round(c.pnl), count: c.count };
        total += c.pnl;
        totalCount += c.count;
      }
      return { day, byTrack, total: round(total), totalCount };
    });

  // Per-book totals across all days (footer row).
  const totals: Record<string, Cell> = {};
  let grand = 0;
  let grandCount = 0;
  for (const tr of tracks) {
    let pnl = 0;
    let count = 0;
    for (const d of days) {
      pnl += d.byTrack[tr].pnl;
      count += d.byTrack[tr].count;
    }
    totals[tr] = { pnl: round(pnl), count };
    grand += pnl;
    grandCount += count;
  }

  return { tracks: [...tracks], days, totals, grandTotal: round(grand), grandCount };
}

/**
 * Category performance per book — "does esports do better in live than in
 * core?". Buckets every SETTLED paper trade by (track, derived category) and
 * reports realized PnL / win rate / count. Category is DERIVED from the
 * market question (see lib/category.ts — the API's own category field is
 * ~98% null). Combo is excluded: a parlay's "first leg" category is a weak
 * signal for a 2-32-leg bet, and the book is still near-empty.
 */
export function getCategoryPerformance(db: Db) {
  const tracks = ["core", "live", "trade", "crypto", "elite"] as const;
  const rows = db
    .select({
      track: paperTrades.track,
      marketQuestion: paperTrades.marketQuestion,
      realizedPnl: paperTrades.realizedPnl,
    })
    .from(paperTrades)
    .where(ne(paperTrades.status, "open"))
    .all();

  type Cell = { pnl: number; count: number; wins: number };
  const byTrackCat = new Map<string, Map<CategoryKey, Cell>>();
  for (const t of rows) {
    if (!(tracks as readonly string[]).includes(t.track)) continue;
    const cat = categorizeMarket(t.marketQuestion);
    const trackMap = byTrackCat.get(t.track) ?? new Map<CategoryKey, Cell>();
    const cell = trackMap.get(cat) ?? { pnl: 0, count: 0, wins: 0 };
    cell.pnl += t.realizedPnl ?? 0;
    cell.count += 1;
    if ((t.realizedPnl ?? 0) > 0) cell.wins++;
    trackMap.set(cat, cell);
    byTrackCat.set(t.track, trackMap);
  }

  const allCats = new Set<CategoryKey>();
  for (const m of byTrackCat.values()) for (const c of m.keys()) allCats.add(c);

  const round = (x: number) => Math.round(x * 100) / 100;
  type ArmCell = { pnl: number; count: number; winRate: number | null } | null;
  const categories = [...allCats]
    .map((cat) => {
      const byArm = {} as Record<(typeof tracks)[number], ArmCell>;
      let totalPnl = 0;
      for (const track of tracks) {
        const cell = byTrackCat.get(track)?.get(cat);
        if (cell) {
          byArm[track] = { pnl: round(cell.pnl), count: cell.count, winRate: cell.count ? cell.wins / cell.count : null };
          totalPnl += cell.pnl;
        } else {
          byArm[track] = null;
        }
      }
      return { category: cat, byArm, totalPnl: round(totalPnl) };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);

  // Best category per arm (min 3 settled — avoid crowning a 1-trade fluke).
  const MIN_SAMPLE = 3;
  const bestPerArm = {} as Record<(typeof tracks)[number], CategoryKey | null>;
  for (const track of tracks) {
    let best: { cat: CategoryKey; pnl: number } | null = null;
    for (const row of categories) {
      const cell = row.byArm[track];
      if (!cell || cell.count < MIN_SAMPLE) continue;
      if (!best || cell.pnl > best.pnl) best = { cat: row.category, pnl: cell.pnl };
    }
    bestPerArm[track] = best?.cat ?? null;
  }

  return { tracks: [...tracks], categories, bestPerArm };
}

/**
 * Slice matrices: hour-block / entry-band / weekday performance, per book.
 *
 * Recomputed from scratch on every call — there is no materialized table, so the
 * dashboard always shows the DB as it stands right now. Cheap enough: it is one
 * scan over settled paper trades (a few thousand rows).
 */
export function getSliceMatrices(db: Db, opts?: { sinceMs?: number }) {
  // Period filter (added 2026-07-20, Johan): the all-time aggregate hides how a
  // cell did YESTERDAY vs its whole history — a vein that dried up three days
  // ago still looks green in the total. Filtering by openedAt keeps the axis
  // consistent with the matrices themselves (they bucket by open time).
  const where =
    opts?.sinceMs != null
      ? and(ne(paperTrades.status, "open"), gte(paperTrades.openedAt, new Date(opts.sinceMs)))
      : ne(paperTrades.status, "open");
  const rows = db
    .select({
      track: paperTrades.track,
      entryPrice: paperTrades.entryPrice,
      simulatedPositionSize: paperTrades.simulatedPositionSize,
      realizedPnl: paperTrades.realizedPnl,
      openedAt: paperTrades.openedAt,
      marketQuestion: paperTrades.marketQuestion,
      // Needed by the duration and confluence matrices. Without these the two
      // dimensions silently key to null and their rows never render at all.
      resolvedAt: paperTrades.resolvedAt,
      closedAt: paperTrades.closedAt,
      confluenceCount: paperTrades.confluenceCount,
    })
    .from(paperTrades)
    .where(where)
    .all();

  return buildAllMatrices(rows as SettledTrade[]);
}

/**
 * Flat-stake what-if: "if every copy had staked a fixed $X instead of whatever
 * it actually staked, what would our capital curve look like?" Only core
 * varies its stake ($5-$20, scaled by signal confidence) — the other books
 * already stake flat, so for them actual === simulated (shown anyway, so the
 * comparison table doesn't have a confusing gap).
 *
 * APPROXIMATION: rescales each trade's real realizedPnl linearly by
 * (flatStake / actualStake). This assumes the fill price at $X would have been
 * the same as it was at the actual stake — true for a deep book, optimistic
 * for a thin one (a bigger real stake can walk the book to a worse average
 * price than a smaller one would have gotten). So the flat-stake number here
 * is a slight best case, not a re-run of the real order-book simulation.
 */
export function getFlatStakeSimulation(db: Db, flatStake = 5) {
  const tracks = ["core", "live", "trade", "crypto", "elite"] as const;
  const rows = db
    .select({
      track: paperTrades.track,
      simulatedPositionSize: paperTrades.simulatedPositionSize,
      realizedPnl: paperTrades.realizedPnl,
    })
    .from(paperTrades)
    .where(ne(paperTrades.status, "open"))
    .all();

  const round2 = (x: number) => Math.round(x * 100) / 100;

  return tracks.map((track) => {
    const trs = rows.filter((r) => r.track === track && r.simulatedPositionSize > 0);
    let actualPnl = 0;
    let actualStaked = 0;
    let flatPnl = 0;
    for (const t of trs) {
      const pnl = t.realizedPnl ?? 0;
      actualPnl += pnl;
      actualStaked += t.simulatedPositionSize;
      flatPnl += pnl * (flatStake / t.simulatedPositionSize);
    }
    const flatStaked = trs.length * flatStake;
    return {
      track,
      count: trs.length,
      actualPnl: round2(actualPnl),
      actualStaked: round2(actualStaked),
      actualRoi: actualStaked > 0 ? actualPnl / actualStaked : null,
      flatPnl: round2(flatPnl),
      flatStaked: round2(flatStaked),
      flatRoi: flatStaked > 0 ? flatPnl / flatStaked : null,
      variesStake: track === "core",
    };
  });
}

/**
 * Parked-capital projection: how many positions the core book would hold open in
 * steady state for different max-resolution windows. Uses the real hold-time
 * distribution of already-settled copies + the recent daily copy rate. Lets the
 * window be chosen against how many open positions ("lung") is tolerable.
 */
export function getResolutionWindowProjection(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" | "elite" = "core") {
  const trades = db
    .select({
      status: paperTrades.status,
      openedAt: paperTrades.openedAt,
      resolvedAt: paperTrades.resolvedAt,
      closedAt: paperTrades.closedAt,
    })
    .from(paperTrades)
    .where(eq(paperTrades.track, track))
    .all();

  const DAY = 86_400_000;
  const now = Date.now();
  const settled = trades.filter((t) => t.status !== "open");
  const holdDays = settled
    .map((t) => {
      const settleAt = t.resolvedAt ?? t.closedAt;
      return settleAt ? (settleAt.getTime() - t.openedAt.getTime()) / DAY : null;
    })
    .filter((h): h is number => h !== null && h >= 0);

  // Arrival rate from the last 7 days of opens (fall back to full span if newer).
  const sevenAgo = now - 7 * DAY;
  const recentOpens = trades.filter((t) => t.openedAt.getTime() >= sevenAgo).length;
  const firstOpen = trades.reduce((min, t) => Math.min(min, t.openedAt.getTime()), now);
  const spanDays = Math.max(1, Math.min(7, (now - firstOpen) / DAY));
  const arrivalPerDay = recentOpens / spanDays;

  const sortedHold = [...holdDays].sort((a, b) => a - b);
  const medianHoldDays = sortedHold.length
    ? Math.round(sortedHold[Math.floor(sortedHold.length / 2)] * 10) / 10
    : 0;

  const currentOpen = trades.filter((t) => t.status === "open").length;
  // UNBIASED average hold from the live system (Little's Law inverted):
  // L = λ·W  ->  W = L/λ. Unlike the settled-only sample this includes the
  // long-dated positions still open, so it doesn't undercount the slow tail.
  const impliedAvgHoldDays =
    arrivalPerDay > 0 ? Math.round((currentOpen / arrivalPerDay) * 10) / 10 : 0;

  // Ages (days) of the positions still OPEN — reveals the long-dated tail the
  // settled sample hides. How many open right now are older than each window.
  const openAges = trades
    .filter((t) => t.status === "open")
    .map((t) => (now - t.openedAt.getTime()) / DAY);
  const openOlderThan = (d: number) => openAges.filter((a) => a > d).length;

  return {
    currentOpen,
    settledSample: holdDays.length,
    arrivalPerDay: Math.round(arrivalPerDay * 10) / 10,
    medianHoldDays,
    impliedAvgHoldDays,
    openOlderThan5: openOlderThan(5),
    openOlderThan14: openOlderThan(14),
    openOlderThan30: openOlderThan(30),
    projection: projectOpenByWindow(holdDays, arrivalPerDay, [3, 5, 14, 30, 45]),
  };
}

/** Recent AI analyst runs (expert reads + recommendations), newest first. */
export function getAiAnalyses(db: Db, limit = 20) {
  return db.select().from(aiAnalyses).orderBy(desc(aiAnalyses.createdAt)).limit(limit).all();
}

/** Fill-rate realism metric: how many paper_copy decisions actually filled. */
export function getFillRateStats(db: Db) {
  const copies = db
    .select()
    .from(decisionJournal)
    .where(eq(decisionJournal.decision, "paper_copy"))
    .all();
  const trades = db.select().from(paperTrades).where(eq(paperTrades.track, "core")).all();
  const filled = new Set(trades.map((t) => t.decisionJournalId));
  const fillCount = copies.filter((c) => filled.has(c.id)).length;
  return {
    copyDecisions: copies.length,
    filled: fillCount,
    unfillable: copies.length - fillCount,
    fillRate: copies.length ? fillCount / copies.length : null,
  };
}
