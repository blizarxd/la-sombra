import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
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
  const trades = db.select().from(paperTrades).all();
  const open = trades.filter((t) => t.status === "open");
  const resolved = trades.filter((t) => t.status === "resolved");
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
export function getPnlSeries(db: Db): { t: number; pnl: number }[] {
  const snaps = db
    .select({
      paperTradeId: pnlSnapshots.paperTradeId,
      pnl: pnlSnapshots.pnl,
      collectedAt: pnlSnapshots.collectedAt,
    })
    .from(pnlSnapshots)
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

/** Build decision-outcome rows for benchmark comparisons. */
export function getDecisionOutcomes(db: Db): DecisionOutcomeRow[] {
  const decisions = db.select().from(decisionJournal).all();
  if (decisions.length === 0) return [];
  const trades = db.select().from(paperTrades).all();
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

    const resolved = Boolean(paper?.status === "resolved" || (review && review.finalOutcome && review.finalOutcome !== "pending"));
    const paperPnl = paper?.status === "resolved" ? (paper.realizedPnl ?? null) : null;

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
    .groupBy(observedTrades.marketCategory)
    .all();
  return rows.map((r) => ({
    category: r.category ?? "Other",
    totalPnl: Math.round(r.pnl * 100) / 100,
    tradeCount: r.count,
  }));
}

/** Fill-rate realism metric: how many paper_copy decisions actually filled. */
export function getFillRateStats(db: Db) {
  const copies = db
    .select()
    .from(decisionJournal)
    .where(eq(decisionJournal.decision, "paper_copy"))
    .all();
  const trades = db.select().from(paperTrades).all();
  const filled = new Set(trades.map((t) => t.decisionJournalId));
  const fillCount = copies.filter((c) => filled.has(c.id)).length;
  return {
    copyDecisions: copies.length,
    filled: fillCount,
    unfillable: copies.length - fillCount,
    fillRate: copies.length ? fillCount / copies.length : null,
  };
}
