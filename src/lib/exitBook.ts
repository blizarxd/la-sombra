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
 * 🚪 EXIT BOOK — the strategy is the exit, not the entry.
 *
 * Measured across 10,381 settled copies: positions closed by following the
 * copied wallet out returned +39.1% (esports +43.2%, n=292, 70% win rate),
 * while positions held to the oracle returned -7.8%. Same signals, same
 * arms — the difference is entirely in how they ended.
 *
 * ⚠️ The headline number is NOT directly reachable. "Trades where the wallet
 * later sold" is a population defined by the future; admitting only those
 * would be selecting on information the strategy never had at entry — the same
 * mistake that inflated an earlier capital simulation 4x. What IS reachable is
 * the discipline: enter as the arms do, and never wait for the oracle.
 *
 * So every position leaves by one of three doors, and the BLEND is the honest
 * result:
 *   1. the wallet sells      -> follow them out (the case the finding is about)
 *   2. the price stops being in doubt -> sell into it
 *   3. neither, in time      -> cut anyway at the market price (the time stop)
 *
 * Door 3 is the one that makes this measurement honest: it is what happens
 * when the wallet never sells, and its cost is exactly what the raw +39.1%
 * left out.
 */

export const CAPITAL_START = 500;
export const FLAT_STAKE = 60;
export const MAX_CONCURRENT = 5;

/**
 * Hours before the time stop cuts a position that has neither been exited by
 * the wallet nor decided by price. Set at the average holding time of the
 * profitable exit-copied population (~6h): long enough to give the wallet its
 * usual window to sell, short enough that we are not drifting into the
 * hold-to-oracle population that lost 7.8%.
 */
export const TIME_STOP_HOURS = 6;

/** La Crema mirrors what other arms already copied; counting it double-counts. */
export function isMirrorTrack(track: string): boolean {
  return track === "elite";
}

/**
 * Entry is deliberately BROAD: no band, no category, no duration filter. The
 * hypothesis under test is about exit discipline, so narrowing entry as well
 * would blur which of the two is doing the work.
 */
export function isEligible(t: { track: string }): boolean {
  return !isMirrorTrack(t.track);
}

export type ExitDoor = "salida-billetera" | "precio-decidido" | "tiempo-agotado" | "resolucion";

export const EXIT_DOOR_LABELS: Record<ExitDoor, string> = {
  "salida-billetera": "la billetera vendió",
  "precio-decidido": "precio ya decidido",
  "tiempo-agotado": "corte por tiempo",
  resolucion: "llegó al oráculo",
};

export interface ExitVerdict {
  door: ExitDoor;
  /** Price we get out at. */
  price: number;
}

/**
 * Decide whether an open position leaves now, and through which door.
 *
 * Order matters and encodes the strategy: the wallet's own exit is the signal
 * we are actually copying, so it wins whenever it is available. Price-decided
 * comes next because it frees capital at a known value. The time stop is last
 * — it is the fallback, not the plan.
 *
 * `resolucion` is returned only when the arm's trade resolved before any of the
 * above could fire, which for this book counts as a MISS: the discipline
 * failed to get us out in time, and its result must still be counted.
 */
export function decideExit(params: {
  armStatus: string;
  armClosedAt: Date | null;
  armResolvedAt: Date | null;
  /** Exit price recovered from the arm's own realized result, when settled. */
  armExitPrice: number | null;
  currentPrice: number | null;
  heldHours: number;
  timeStopHours?: number;
}): ExitVerdict | null {
  const stop = params.timeStopHours ?? TIME_STOP_HOURS;

  // The arm already settled: inherit HOW it settled.
  if (params.armStatus !== "open") {
    if (params.armExitPrice === null) return null;
    // "closed" on an arm trade means the copied wallet sold and the arm
    // followed — precisely the event this book is built around.
    const door: ExitDoor = params.armStatus === "closed" ? "salida-billetera" : "resolucion";
    return { door, price: params.armExitPrice };
  }

  // Still open at the arm: we may still leave on our own terms.
  if (params.currentPrice === null) return null;
  if (isDecided(params.currentPrice)) return { door: "precio-decidido", price: params.currentPrice };
  if (params.heldHours >= stop) return { door: "tiempo-agotado", price: params.currentPrice };
  return null;
}

/** One bet per market+outcome: two arms agreeing is not two bets. */
export { armExitPrice, concurrentAt, decide, isDecided, positionKey, realStakeFill, settledPnl };
export type { Decision, OpenWindow };

export function categoryOf(question: string | null): CategoryKey {
  return categorizeMarket(question);
}
