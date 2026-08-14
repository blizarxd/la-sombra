import {
  armExitPrice,
  concurrentAt,
  decide,
  isDecided,
  positionKey,
  realStakeFill,
  settledPnl,
  type Decision,
  type OpenWindow,
} from "@/lib/capitalBook";
import { categorizeMarket, type CategoryKey } from "@/lib/category";

/**
 * ⚡ FAST BOOK — forward-test of /matriz's duration finding.
 *
 * The band book (capitalBook.ts) tests "does entry price predict edge?". This
 * tests a different finding off the SAME matrix: markets SCHEDULED to resolve
 * within an hour showed the strongest, most consistent cells on the whole
 * board (esports +17.9%, n=401; deportes +8.4%, n=359 — cripto's <1h cell was
 * only +0.5%, too weak to trust, so it is left out here).
 *
 * Fast turnover also attacks the band book's real problem directly: with
 * signals arriving faster than a few slots can absorb, a book whose positions
 * close in under an hour should barely ever be capital- or slot-starved. If it
 * still starves, that is itself informative.
 *
 * Reuses the band book's generic bankroll mechanics (decide/concurrentAt/
 * positionKey/pricing carry no band-specific assumption) — only eligibility
 * differs. Eligibility runs on expectedResolutionHours captured AT ENTRY —
 * never the trade's actual settle time, which would be answering with
 * information the strategy never had.
 */

export const CAPITAL_START = 500;
export const FLAT_STAKE = 60;
export const MAX_CONCURRENT = 5;

/** Threshold matching the /matriz "⚡ < 1h · relámpago" duration bucket. */
export const FAST_RESOLVE_HOURS = 1;

/** Only the categories whose <1h cell was actually positive with real n. */
const ELIGIBLE_CATEGORIES: CategoryKey[] = ["esports", "deportes"];

export { armExitPrice, concurrentAt, decide, isDecided, positionKey, realStakeFill, settledPnl };
export type { Decision, OpenWindow };

export function isMirrorTrack(track: string): boolean {
  return track === "elite";
}

export function isEligible(t: {
  track: string;
  marketQuestion: string | null;
  expectedResolutionHours: number | null;
}): boolean {
  if (isMirrorTrack(t.track)) return false;
  if (t.expectedResolutionHours === null || t.expectedResolutionHours === undefined) return false;
  // Negative means the market's scheduled end already passed at entry — stale
  // metadata, not a fast market.
  if (t.expectedResolutionHours <= 0 || t.expectedResolutionHours > FAST_RESOLVE_HOURS) return false;
  return ELIGIBLE_CATEGORIES.includes(categorizeMarket(t.marketQuestion));
}
