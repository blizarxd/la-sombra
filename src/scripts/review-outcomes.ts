import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  decisionJournal,
  marketSnapshots,
  observedTrades,
  outcomeReviews,
  paperTrades,
  pnlSnapshots,
} from "@/db/schema";
import { fetchMarketsByConditionIds } from "@/lib/adapters";
import type { MarketInfo } from "@/lib/adapters/types";
import { hypotheticalPnl } from "@/lib/benchmarks";
import { isSyntheticComboConditionId } from "@/lib/combos";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * Step 12 of the loop: judge past decisions. Fill in +1h/+6h/+24h prices from
 * stored snapshots, settle final outcomes when markets resolve, decide whether
 * each decision was good, and write down the lesson.
 */

function priceNear(
  db: Parameters<Parameters<typeof runScript>[1]>[0],
  marketId: string,
  targetMs: number,
  toleranceMs = 3 * 3600 * 1000,
): number | null {
  const row = db
    .select()
    .from(marketSnapshots)
    .where(
      and(
        eq(marketSnapshots.marketId, marketId),
        gte(marketSnapshots.collectedAt, new Date(targetMs - toleranceMs)),
        lte(marketSnapshots.collectedAt, new Date(targetMs + toleranceMs)),
      ),
    )
    .orderBy(asc(marketSnapshots.collectedAt))
    .all()
    .sort((a, b) => Math.abs(a.collectedAt.getTime() - targetMs) - Math.abs(b.collectedAt.getTime() - targetMs))[0];
  return row?.bestAsk ?? row?.yesPrice ?? null;
}

runScript("review:outcomes", async (db) => {
  const decisions = db.select().from(decisionJournal).orderBy(asc(decisionJournal.createdAt)).all();
  if (decisions.length === 0) {
    log.info("no decisions to review yet");
    return;
  }
  const marketCache = new Map<string, MarketInfo>();
  let createdOrUpdated = 0;

  for (const d of decisions) {
    // 🧩 Combo decisions live in their own ledger: their synthetic conditionIds
    // resolve nowhere (CLOB 404s) and combo-tick settles them from the source
    // wallet's activity. Skipping keeps core benchmarks combo-free.
    if (isSyntheticComboConditionId(d.marketId)) continue;
    const existing = db
      .select()
      .from(outcomeReviews)
      .where(eq(outcomeReviews.decisionJournalId, d.id))
      .get();
    if (existing && existing.finalOutcome && existing.finalOutcome !== "pending") continue; // fully reviewed

    const obs = db.select().from(observedTrades).where(eq(observedTrades.id, d.observedTradeId)).get();
    // Only CORE paper trades judge a decision — live-experiment trades live in
    // their own parallel ledger and must not color the core benchmark.
    const paper = db
      .select()
      .from(paperTrades)
      .where(and(eq(paperTrades.decisionJournalId, d.id), eq(paperTrades.track, "core")))
      .get();
    const ageMs = Date.now() - d.createdAt.getTime();
    const t0 = d.createdAt.getTime();

    // --- interval prices (prefer per-trade pnl snapshots, fall back to market snapshots) ---
    const intervalPrice = (hours: number): number | null => {
      if (ageMs < hours * 3600 * 1000) return null;
      if (paper) {
        const snap = db
          .select()
          .from(pnlSnapshots)
          .where(
            and(
              eq(pnlSnapshots.paperTradeId, paper.id),
              gte(pnlSnapshots.collectedAt, new Date(t0 + (hours - 1.5) * 3600 * 1000)),
              lte(pnlSnapshots.collectedAt, new Date(t0 + (hours + 1.5) * 3600 * 1000)),
            ),
          )
          .orderBy(asc(pnlSnapshots.collectedAt))
          .all()
          .sort(
            (a, b) =>
              Math.abs(a.collectedAt.getTime() - (t0 + hours * 3600 * 1000)) -
              Math.abs(b.collectedAt.getTime() - (t0 + hours * 3600 * 1000)),
          )[0];
        if (snap) return snap.price;
      }
      return priceNear(db, d.marketId, t0 + hours * 3600 * 1000);
    };

    const priceAfter1h = existing?.priceAfter1h ?? intervalPrice(1);
    const priceAfter6h = existing?.priceAfter6h ?? intervalPrice(6);
    const priceAfter24h = existing?.priceAfter24h ?? intervalPrice(24);

    // --- final outcome ---
    let finalOutcome: string = existing?.finalOutcome ?? "pending";
    let simulatedPnl: number | null = existing?.simulatedPnl ?? null;
    let wasDecisionGood: boolean | null = existing?.wasDecisionGood ?? null;
    const lessons: string[] = [];

    if (paper?.status === "resolved") {
      finalOutcome = (paper.realizedPnl ?? 0) >= 0 ? "won" : "lost";
      simulatedPnl = paper.realizedPnl ?? null;
    } else if (!paper && ageMs > 6 * 3600 * 1000 && d.marketId.startsWith("0x")) {
      // Check resolution for watchlist/skip decisions so we can count missed winners / avoided losers.
      if (!marketCache.has(d.marketId)) {
        const fetched = await fetchMarketsByConditionIds([d.marketId]);
        if (fetched[0]) marketCache.set(d.marketId, fetched[0]);
      }
      const market = marketCache.get(d.marketId);
      if (market?.resolved && market.winningOutcomeIndex !== null && obs) {
        const winnerName = market.outcomes[market.winningOutcomeIndex];
        let won: boolean | null = null;
        if (obs.outcome && winnerName) won = obs.outcome.toLowerCase() === winnerName.toLowerCase();
        else if (obs.tokenId) won = market.clobTokenIds.indexOf(obs.tokenId) === market.winningOutcomeIndex;
        if (won !== null) {
          finalOutcome = won ? "won" : "lost";
          const entry = obs.detectedPrice ?? obs.walletEntryPrice;
          simulatedPnl = hypotheticalPnl(entry, won ? 1 : 0);
        }
      }
    }

    // --- judge the decision ---
    if (finalOutcome !== "pending") {
      if (d.decision === "paper_copy") {
        wasDecisionGood = (simulatedPnl ?? 0) > 0;
        lessons.push(
          wasDecisionGood
            ? `good copy: +$${(simulatedPnl ?? 0).toFixed(2)} — signal profile worked`
            : `bad copy: $${(simulatedPnl ?? 0).toFixed(2)} — review wallet quality & entry timing subscores`,
        );
      } else if (d.decision === "skip") {
        wasDecisionGood = (simulatedPnl ?? 0) <= 0;
        lessons.push(
          wasDecisionGood
            ? "good skip: copying would have lost (avoided loser)"
            : "missed winner: skipped a signal that ended profitable — check which gate blocked it",
        );
      } else {
        wasDecisionGood = (simulatedPnl ?? 0) <= 0;
        lessons.push(
          wasDecisionGood
            ? "watchlist held correctly: no profit missed"
            : "missed winner on watchlist — threshold may be too strict",
        );
      }
    }

    const now = new Date();
    if (existing) {
      db.update(outcomeReviews)
        .set({
          priceAfter1h,
          priceAfter6h,
          priceAfter24h,
          finalOutcome,
          simulatedPnl,
          wasDecisionGood,
          lessonsJson: lessons.length ? JSON.stringify(lessons) : existing.lessonsJson,
          reviewTime: now,
        })
        .where(eq(outcomeReviews.id, existing.id))
        .run();
    } else {
      db.insert(outcomeReviews)
        .values({
          id: newId(),
          decisionJournalId: d.id,
          paperTradeId: paper?.id ?? null,
          reviewTime: now,
          priceAfter1h,
          priceAfter6h,
          priceAfter24h,
          finalOutcome,
          simulatedPnl,
          wasDecisionGood,
          lessonsJson: lessons.length ? JSON.stringify(lessons) : null,
          createdAt: now,
        })
        .run();
    }
    createdOrUpdated++;
  }
  log.info(`reviews created/updated: ${createdOrUpdated}`);
});
