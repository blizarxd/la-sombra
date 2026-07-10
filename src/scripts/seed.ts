import {
  dailyReports,
  decisionJournal,
  leaderboardScans,
  marketSnapshots,
  observedTrades,
  outcomeReviews,
  paperTrades,
  pnlSnapshots,
  walletProfiles,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { getActiveRules } from "@/lib/rules";
import { runScript } from "./_runner";

/**
 * Seed: ensures rule set v1 exists and inserts CLEARLY-LABELED demo data so
 * the dashboard is explorable before the first real scan. Every demo row is
 * tagged with "[DEMO]" — the UI shows it and reality is never mixed with it.
 */

const H = 3600 * 1000;
const now = Date.now();

runScript("seed", async (db) => {
  getActiveRules(db); // seeds rule set v1 (defaults) if missing

  const already = db.select().from(leaderboardScans).all().some((s) => s.source === "demo-seed");
  if (already) {
    log.info("demo seed already present — nothing to do (rule set verified)");
    return;
  }

  const ts = (msAgo: number) => new Date(now - msAgo);

  db.insert(leaderboardScans)
    .values({
      id: newId(),
      source: "demo-seed",
      scannedAt: ts(26 * H),
      walletCount: 6,
      lookbackDays: 30,
      rawSummaryJson: JSON.stringify({ note: "[DEMO] synthetic data for dashboard preview" }),
    })
    .run();

  // --- demo wallets -------------------------------------------------------
  const wallets = [
    { addr: "0xdemo000000000000000000000000000000000001", label: "[DEMO] SteadyEddie", status: "track" as const, roi: 0.22, cons: 78, copy: 74, ohw: 0, global: 76, cat: "Crypto", win: 0.64, n: 42, resolved: 25 },
    { addr: "0xdemo000000000000000000000000000000000002", label: "[DEMO] PoliticsShark", status: "track" as const, roi: 0.31, cons: 65, copy: 68, ohw: 12, global: 68, cat: "Politics", win: 0.6, n: 35, resolved: 20 },
    { addr: "0xdemo000000000000000000000000000000000003", label: "[DEMO] OneLuckyPunch", status: "ignore" as const, roi: 0.85, cons: 22, copy: 40, ohw: 88, global: 34, cat: "Sports", win: 0.35, n: 20, resolved: 17 },
    { addr: "0xdemo000000000000000000000000000000000004", label: "[DEMO] ThinIceTrader", status: "ignore" as const, roi: 0.4, cons: 55, copy: 18, ohw: 10, global: 38, cat: "Other", win: 0.55, n: 28, resolved: 11 },
    { addr: "0xdemo000000000000000000000000000000000005", label: "[DEMO] SlowGrinder", status: "watch" as const, roi: 0.08, cons: 70, copy: 62, ohw: 0, global: 52, cat: "Crypto", win: 0.55, n: 51, resolved: 30 },
    { addr: "0xdemo000000000000000000000000000000000006", label: "[DEMO] FreshFace", status: "watch" as const, roi: 0.15, cons: 35, copy: 50, ohw: 25, global: 45, cat: "Politics", win: 0.5, n: 8, resolved: 4 },
  ];
  for (const w of wallets) {
    db.insert(walletProfiles)
      .values({
        id: newId(),
        address: w.addr,
        label: w.label,
        sourceRank: null, // demo wallets never enter the real ranking/profiling queue
        status: w.status,
        roi30d: w.roi,
        consistencyScore: w.cons,
        copyabilityScore: w.copy,
        oneHitWonderPenalty: w.ohw,
        globalScore: w.global,
        bestCategory: w.cat,
        categoryStrengthsJson: JSON.stringify({ [w.cat]: { trades: Math.round(w.n / 2), pnl: 120, winRate: w.win } }),
        averageTradeSize: 180,
        tradeCount30d: w.n,
        resolvedTradeCount30d: w.resolved,
        winRate30d: w.win,
        averageLiquidity: w.copy > 50 ? 4200 : 240,
        averageSpread: w.copy > 50 ? 0.02 : 0.09,
        averageEntryTiming: w.copy > 50 ? 0.02 : 0.11,
        copyabilityNotes:
          w.status === "track"
            ? "[DEMO] liquid markets, tight spreads, steady weekly profit"
            : w.status === "watch"
              ? "[DEMO] promising but needs more resolved history"
              : w.ohw > 50
                ? "[DEMO] one-hit wonder: 88% of profit from a single trade"
                : "[DEMO] trades markets too thin to copy",
        riskNotes: w.ohw > 50 ? "[DEMO] profit concentration risk" : null,
        lastScannedAt: ts(2 * H),
        createdAt: ts(26 * H),
        updatedAt: ts(2 * H),
      })
      .run();
  }

  // --- demo markets + signals + decisions + paper trades ------------------
  const demoSignals = [
    { q: "[DEMO] Will BTC close above $120k this week?", cat: "Crypto", cond: "0xdemo-cond-1", tok: "demo-tok-1", wallet: wallets[0].addr, entry: 0.55, ask: 0.57, bid: 0.55, liq: 5200, decision: "paper_copy" as const, score: 72, size: 9.5, outcome: "Yes", resolvedWon: true, hoursAgo: 30 },
    { q: "[DEMO] Will the Fed cut rates in September?", cat: "Politics", cond: "0xdemo-cond-2", tok: "demo-tok-2", wallet: wallets[1].addr, entry: 0.62, ask: 0.64, bid: 0.62, liq: 8900, decision: "paper_copy" as const, score: 69, size: 7.8, outcome: "Yes", resolvedWon: false, hoursAgo: 28 },
    { q: "[DEMO] Will ETH flip $4k before Friday?", cat: "Crypto", cond: "0xdemo-cond-3", tok: "demo-tok-3", wallet: wallets[0].addr, entry: 0.48, ask: 0.49, bid: 0.47, liq: 3100, decision: "paper_copy" as const, score: 75, size: 12.4, outcome: "Yes", resolvedWon: null, hoursAgo: 8 },
    { q: "[DEMO] Team X wins the championship?", cat: "Sports", cond: "0xdemo-cond-4", tok: "demo-tok-4", wallet: wallets[2].addr, entry: 0.91, ask: 0.93, bid: 0.9, liq: 1500, decision: "skip" as const, score: 31, size: null, outcome: "Yes", resolvedWon: false, hoursAgo: 20 },
    { q: "[DEMO] Obscure micro-market resolves Yes?", cat: "Other", cond: "0xdemo-cond-5", tok: "demo-tok-5", wallet: wallets[3].addr, entry: 0.4, ask: 0.52, bid: 0.35, liq: 90, decision: "skip" as const, score: 28, size: null, outcome: "Yes", resolvedWon: false, hoursAgo: 18 },
    { q: "[DEMO] Will CPI print under 3.0%?", cat: "Politics", cond: "0xdemo-cond-6", tok: "demo-tok-6", wallet: wallets[4].addr, entry: 0.44, ask: 0.46, bid: 0.44, liq: 2600, decision: "watchlist" as const, score: 55, size: null, outcome: "Yes", resolvedWon: true, hoursAgo: 26 },
  ];

  for (const s of demoSignals) {
    const created = ts(s.hoursAgo * H);
    const obsId = newId();
    db.insert(observedTrades)
      .values({
        id: obsId,
        walletAddress: s.wallet,
        marketId: s.cond,
        conditionId: s.cond,
        tokenId: s.tok,
        marketQuestion: s.q,
        marketCategory: s.cat,
        outcome: s.outcome,
        side: "BUY",
        walletEntryPrice: s.entry,
        detectedPrice: s.ask,
        size: 150,
        timestamp: created,
        dedupeKey: `demo-${s.cond}`,
        scored: true,
        rawTradeJson: JSON.stringify({ demo: true }),
        createdAt: created,
      })
      .run();

    db.insert(marketSnapshots)
      .values({
        id: newId(),
        marketId: s.cond,
        conditionId: s.cond,
        question: s.q,
        category: s.cat,
        yesPrice: s.ask,
        noPrice: 1 - s.ask,
        bestBid: s.bid,
        bestAsk: s.ask,
        spread: Math.round((s.ask - s.bid) * 100) / 100,
        liquidity: s.liq,
        volume: s.liq * 12,
        timeToResolution: 72,
        collectedAt: created,
        rawMarketJson: JSON.stringify({ demo: true }),
      })
      .run();

    const journalId = newId();
    const reasons =
      s.decision === "paper_copy"
        ? ["[DEMO] copy score above threshold", "tight spread", "high-quality wallet"]
        : s.decision === "watchlist"
          ? ["[DEMO] interesting wallet but score in watch band"]
          : s.score === 31
            ? ["[DEMO] entry band: ask 0.93 > max 0.82"]
            : ["[DEMO] liquidity $90 < min $500"];
    const risks = s.decision === "skip" ? ["[DEMO] extreme price / illiquid book"] : ["[DEMO] normal market risk"];
    db.insert(decisionJournal)
      .values({
        id: journalId,
        observedTradeId: obsId,
        walletAddress: s.wallet,
        marketId: s.cond,
        decision: s.decision,
        copyScore: s.score,
        confidence: s.score / 100,
        reasonsJson: JSON.stringify(reasons),
        risksJson: JSON.stringify(risks),
        walletQualityScore: 70,
        roiScore: 65,
        consistencyScore: 70,
        copyabilityScore: 68,
        categoryFitScore: 75,
        entryTimingScore: s.decision === "skip" ? 20 : 80,
        spreadScore: s.liq > 1000 ? 80 : 15,
        liquidityScore: s.liq > 1000 ? 78 : 10,
        thesisScore: 55,
        simulatedPositionSize: s.size,
        ruleSetVersion: 1,
        createdAt: created,
      })
      .run();

    let paperId: string | null = null;
    if (s.decision === "paper_copy" && s.size) {
      paperId = newId();
      const shares = s.size / s.ask;
      const resolved = s.resolvedWon !== null;
      const realized = resolved ? (s.resolvedWon ? shares - s.size : -s.size) : null;
      db.insert(paperTrades)
        .values({
          id: paperId,
          decisionJournalId: journalId,
          walletAddress: s.wallet,
          marketId: s.cond,
          tokenId: s.tok,
          marketQuestion: s.q,
          outcome: s.outcome,
          side: "BUY",
          entryPrice: s.ask,
          currentPrice: resolved ? (s.resolvedWon ? 1 : 0) : s.ask + 0.03,
          simulatedPositionSize: s.size,
          shares,
          spreadCostPaid: ((s.ask - s.bid) / 2) * shares,
          unrealizedPnl: resolved ? null : Math.round(shares * 0.03 * 100) / 100,
          realizedPnl: realized,
          status: resolved ? "resolved" : "open",
          openedAt: created,
          resolvedAt: resolved ? ts((s.hoursAgo - 20) * H) : null,
        })
        .run();
      // hourly-ish pnl snapshots
      const steps = resolved ? 5 : 4;
      for (let i = 1; i <= steps; i++) {
        const drift = (i / steps) * (s.resolvedWon === false ? -0.2 : 0.06);
        const price = resolved && i === steps ? (s.resolvedWon ? 1 : 0) : Math.max(0.02, s.ask + drift);
        const pnl = Math.round((shares * price - s.size) * 100) / 100;
        db.insert(pnlSnapshots)
          .values({ id: newId(), paperTradeId: paperId, price, pnl, collectedAt: ts((s.hoursAgo - i * 4) * H) })
          .run();
      }
    }

    if (s.resolvedWon !== null) {
      const hypo = s.resolvedWon ? Math.round((10 / s.ask - 10) * 100) / 100 : -10;
      const good =
        s.decision === "paper_copy" ? s.resolvedWon : s.decision === "skip" ? !s.resolvedWon : !s.resolvedWon;
      db.insert(outcomeReviews)
        .values({
          id: newId(),
          decisionJournalId: journalId,
          paperTradeId: paperId,
          reviewTime: ts((s.hoursAgo - 22) * H),
          priceAfter1h: s.ask + 0.01,
          priceAfter6h: s.ask + (s.resolvedWon ? 0.05 : -0.08),
          priceAfter24h: s.resolvedWon ? 0.95 : 0.1,
          finalOutcome: s.resolvedWon ? "won" : "lost",
          simulatedPnl: s.decision === "paper_copy" && s.size ? (s.resolvedWon ? (s.size / s.ask) - s.size : -s.size) : hypo,
          wasDecisionGood: good,
          lessonsJson: JSON.stringify([
            good
              ? `[DEMO] ${s.decision} was correct for this signal profile`
              : `[DEMO] ${s.decision} judged wrong — evidence for the rule updater`,
          ]),
          createdAt: ts((s.hoursAgo - 22) * H),
        })
        .run();
    }
  }

  // --- demo daily report (yesterday) --------------------------------------
  const yesterday = new Date(now - 24 * H).toISOString().slice(0, 10);
  db.insert(dailyReports)
    .values({
      id: newId(),
      date: yesterday,
      paperPnl: -1.03,
      winRate: 0.5,
      openPositions: 1,
      newSignals: 6,
      copiedSignals: 3,
      watchedSignals: 1,
      skippedSignals: 2,
      bestWalletsJson: JSON.stringify([{ walletAddress: wallets[0].addr, totalPnl: 7.7, tradeCount: 2 }]),
      worstWalletsJson: JSON.stringify([{ walletAddress: wallets[1].addr, totalPnl: -7.8, tradeCount: 1 }]),
      ruleChangesJson: JSON.stringify([]),
      summary:
        `[DEMO DATA] La Sombra — EOD report ${yesterday} (PAPER ONLY)\n` +
        "Synthetic preview so the dashboard renders before the first real scan.\n" +
        "Run npm run scan:leaderboard to start collecting real data.",
      sentToTelegram: false,
      createdAt: ts(20 * H),
    })
    .run();

  log.info("demo seed inserted: 6 wallets, 6 signals, 3 paper trades, 1 report — all tagged [DEMO]");
});
