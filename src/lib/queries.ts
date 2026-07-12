import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  aiAnalyses,
  dailyReports,
  decisionJournal,
  marketSnapshots,
  observedTrades,
  outcomeReviews,
  paperTrades,
  pnlSnapshots,
  ruleChanges,
  ruleSets,
  walletProfiles,
} from "@/db/schema";
import { computeBenchmarks, hypotheticalPnl, type DecisionOutcomeRow } from "./benchmarks";

/** Shared read-model helpers used by the dashboard pages and reports. */

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
export function getPnlSeries(db: Db, track: "core" | "live" | "trade" = "core"): { t: number; pnl: number }[] {
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
export function getRealizedPnlSeries(db: Db, track: "core" | "live" | "trade" = "core"): { t: number; pnl: number }[] {
  const settled = db
    .select({
      realizedPnl: paperTrades.realizedPnl,
      resolvedAt: paperTrades.resolvedAt,
      closedAt: paperTrades.closedAt,
    })
    .from(paperTrades)
    .where(and(eq(paperTrades.track, track), ne(paperTrades.status, "open")))
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
  const observed = observedIds.length
    ? db.select().from(observedTrades).where(inArray(observedTrades.id, observedIds)).all()
    : [];
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

/** Per-wallet paper performance (realized + unrealized). */
export function getWalletPaperPerformance(db: Db) {
  const rows = db
    .select({
      walletAddress: paperTrades.walletAddress,
      realized: sql<number>`coalesce(sum(${paperTrades.realizedPnl}), 0)`,
      unrealized: sql<number>`coalesce(sum(${paperTrades.unrealizedPnl}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(paperTrades)
    .where(eq(paperTrades.track, "core"))
    .groupBy(paperTrades.walletAddress)
    .all();
  return rows.map((r) => ({
    walletAddress: r.walletAddress,
    totalPnl: Math.round((r.realized + r.unrealized) * 100) / 100,
    tradeCount: r.count,
  }));
}

/** Per-category paper performance from resolved trades joined via journal->observed. */
export function getCategoryPerformance(db: Db) {
  const rows = db
    .select({
      category: observedTrades.marketCategory,
      pnl: sql<number>`coalesce(sum(coalesce(${paperTrades.realizedPnl}, ${paperTrades.unrealizedPnl}, 0)), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(paperTrades)
    .innerJoin(decisionJournal, eq(paperTrades.decisionJournalId, decisionJournal.id))
    .innerJoin(observedTrades, eq(decisionJournal.observedTradeId, observedTrades.id))
    .where(eq(paperTrades.track, "core"))
    .groupBy(observedTrades.marketCategory)
    .all();
  return rows.map((r) => ({
    category: r.category ?? "Other",
    totalPnl: Math.round(r.pnl * 100) / 100,
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
