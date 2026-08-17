import {
  concurrentAt,
  decide,
  isDecided,
  positionKey,
  realStakeFill,
  settledPnl,
  type Decision,
  type OpenWindow,
} from "@/lib/capitalBook";
import { categorizeMarket } from "@/lib/category";
import { markToBid } from "@/lib/paper/engine";
import type { BookLevel } from "@/lib/adapters/types";

/**
 * ₿ CRIPTO BOOK — the one entry-time filter with a positive floor.
 *
 * After a day of live forward-testing, exactly one criterion survived that is
 * BOTH profitable and knowable before betting: category. In the capital book's
 * 100 settled trades, cripto ran +35.5% (n=23, 78% win, 90% floor +6.3%) while
 * esports — three of every four trades — ran -0.0% (n=77, floor -12.2%). All of
 * the book's profit came from a quarter of its trades.
 *
 * ⚠️ What this book deliberately does NOT claim: that selling at 97c is the
 * edge. That cell showed +53% with an 88% win rate, and it is almost certainly
 * selection, not skill — a position reaches 97c BECAUSE it is winning, so
 * "sold at 97c" is close to a synonym for "won". Worse, holding a 97c winner
 * to resolution pays 100c, so selling there is 3c WORSE per trade, not better.
 * The rule is kept purely for capital efficiency: freeing a slot hours early
 * buys more trades, and throughput is the constraint this project keeps hitting.
 * Any read of "97c = profit" is the same trap that inflated an earlier
 * simulation by 4x.
 */

export const CAPITAL_START = 500;
export const FLAT_STAKE = 60;
export const MAX_CONCURRENT = 5;

/** Hours before an undecided position is cut rather than left to the oracle. */
export const TIME_STOP_HOURS = 6;

export function isMirrorTrack(track: string): boolean {
  return track === "elite";
}

/** The whole entry thesis: crypto markets, any price, any arm but La Crema. */
export function isEligible(t: { track: string; marketQuestion: string | null }): boolean {
  if (isMirrorTrack(t.track)) return false;
  return categorizeMarket(t.marketQuestion) === "cripto";
}

/**
 * What selling `shares` would ACTUALLY pay, by walking the recorded bid side
 * rather than assuming the touch absorbs the whole position.
 *
 * Returns null when no sell-side snapshot exists (positions opened before the
 * capture shipped). Null means "unknown", and the caller must not silently
 * substitute the touch price — that is precisely the flattering assumption
 * this exists to remove.
 */
export function realExitValue(bidLevelsJson: string | null, shares: number): number | null {
  if (!bidLevelsJson) return null;
  try {
    const levels = JSON.parse(bidLevelsJson) as BookLevel[];
    if (!Array.isArray(levels) || levels.length === 0) return null;
    return markToBid(levels, shares);
  } catch {
    return null;
  }
}

export type ExitDoor = "precio-decidido" | "salida-billetera" | "tiempo-agotado" | "resolucion";

export const EXIT_DOOR_LABELS: Record<ExitDoor, string> = {
  "precio-decidido": "precio ya decidido",
  "salida-billetera": "la billetera vendió",
  "tiempo-agotado": "corte por tiempo",
  resolucion: "llegó al oráculo",
};

export { concurrentAt, decide, isDecided, positionKey, realStakeFill, settledPnl };
export type { Decision, OpenWindow };
