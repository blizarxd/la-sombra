import { and, desc, eq, gte, inArray, like, ne, sql } from "drizzle-orm";
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
import {
  computeBenchmarks,
  computeSkipAutopsy,
  hypotheticalPnl,
  type DecisionOutcomeRow,
} from "./benchmarks";
import { dayKeyTz } from "./format";
import { projectOpenByWindow } from "./projection";

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
export function getPnlSeries(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" = "core"): { t: number; pnl: number }[] {
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
export function getRealizedPnlSeries(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" = "core"): { t: number; pnl: number }[] {
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
export function getWalletPaperPerformance(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" = "core") {
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
  const tracks = ["core", "live", "trade", "crypto", "combo"] as const;
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
 * Parked-capital projection: how many positions the core book would hold open in
 * steady state for different max-resolution windows. Uses the real hold-time
 * distribution of already-settled copies + the recent daily copy rate. Lets the
 * window be chosen against how many open positions ("lung") is tolerable.
 */
export function getResolutionWindowProjection(db: Db, track: "core" | "live" | "trade" | "crypto" | "combo" = "core") {
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
