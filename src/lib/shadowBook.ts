import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { decisionJournal, observedTrades, outcomeReviews } from "@/db/schema";
import type { ScanTrade } from "./goldEngine";

/**
 * 👻 El Libro Sombra — the evidence the engine was throwing away.
 *
 * Until now the gold scan only ever read `paper_trades`: roughly 69 copies a day.
 * But `review-outcomes` already resolves EVERY declined signal and records what
 * it would have paid (`outcome_reviews.simulated_pnl`, a $10 hypothetical) —
 * about 8,800 a day. That data was written, stored, pruned, and never used to
 * find anything.
 *
 * Worse than waste, it left the search CIRCULAR: the engine could only discover
 * gold in cells it was already betting on, so the seeds confirmed themselves and
 * a vein we had never entered was unreachable by construction.
 *
 * The honest caveat, which is why this stream is fenced off in its own tier:
 * a counterfactual pays NO spread, suffers NO slippage, and assumes a fill that
 * may never have been available. It is systematically optimistic. So it may
 * NOMINATE a cell (status "sospecha") and nothing more — confirmation has to
 * come from real fills, which is what the exploration budget goes and buys.
 *
 * Read-only, paper-only: this module reads reviews and returns numbers.
 */

/** The $10 basis `hypotheticalPnl` uses for every counterfactual. */
export const SHADOW_STAKE = 10;

export type ShadowRow = {
  decision: string;
  simulatedPnl: number | null;
  finalOutcome: string | null;
  marketQuestion: string | null;
  entryPrice: number | null;
  decidedAt: Date | number;
};

/**
 * Turn declined-signal reviews into scannable trades.
 *
 * Deliberately NOT attributed to an arm: we cannot know which book would have
 * taken a signal we declined, and inventing one would let a made-up attribution
 * drive a real rule. With `track` unset the shadow stream only ever feeds the
 * arm-free cell families (hour, category × hour, category × band, band × hour).
 */
export function toShadowTrades(rows: ShadowRow[]): ScanTrade[] {
  const out: ScanTrade[] = [];
  for (const r of rows) {
    if (r.decision === "paper_copy") continue; // that one is already in the real book
    if (r.simulatedPnl === null || r.finalOutcome === "pending" || r.finalOutcome === null) continue;
    if (r.entryPrice === null || !(r.entryPrice > 0) || !(r.entryPrice < 1)) continue;
    out.push({
      track: "shadow",
      entryPrice: r.entryPrice,
      simulatedPositionSize: SHADOW_STAKE,
      realizedPnl: r.simulatedPnl,
      openedAt: r.decidedAt,
      marketQuestion: r.marketQuestion,
      // No settle timestamp exists for a trade that never happened, so shadow
      // cells never populate the hold-duration families. Better a blind spot
      // than a fabricated duration.
      resolvedAt: null,
      closedAt: null,
    });
  }
  return out;
}

/**
 * Load the resolved counterfactuals of every signal the bot declined.
 * Returns [] (never throws) when the tables predate this feature.
 */
export function loadShadowTrades(db: Db, limit = 100_000): ScanTrade[] {
  try {
    const rows = db
      .select({
        decision: decisionJournal.decision,
        simulatedPnl: outcomeReviews.simulatedPnl,
        finalOutcome: outcomeReviews.finalOutcome,
        marketQuestion: observedTrades.marketQuestion,
        entryPrice: sql<number | null>`COALESCE(${observedTrades.detectedPrice}, ${observedTrades.walletEntryPrice})`,
        decidedAt: decisionJournal.createdAt,
      })
      .from(outcomeReviews)
      .innerJoin(decisionJournal, eq(outcomeReviews.decisionJournalId, decisionJournal.id))
      .innerJoin(observedTrades, eq(decisionJournal.observedTradeId, observedTrades.id))
      .where(
        and(
          ne(decisionJournal.decision, "paper_copy"),
          isNotNull(outcomeReviews.simulatedPnl),
          ne(outcomeReviews.finalOutcome, "pending"),
        ),
      )
      .limit(limit)
      .all();
    return toShadowTrades(rows as ShadowRow[]);
  } catch {
    return [];
  }
}
