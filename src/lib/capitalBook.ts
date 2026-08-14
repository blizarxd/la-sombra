import { categorizeMarket, type CategoryKey } from "@/lib/category";
import { parseLadder } from "@/lib/depth";
import { fineBandKey } from "@/lib/slices";

/**
 * 💰 CAPITAL BOOK — could ONE bankroll actually have traded this?
 *
 * The arms answer "does this signal have edge?" by copying a small flat size
 * with no shared wallet and no limit on how many run at once. That is the right
 * way to MEASURE an edge and the wrong way to estimate a return: a real account
 * has finite cash, can only hold so many positions at a time, and pays a worse
 * price for a bigger stake.
 *
 * This applies those three constraints to the signals as they arrive, forward
 * only. Its whole purpose is to be the pessimistic twin of the arms' numbers —
 * if it disagrees with them, IT is the one closer to what an account would see.
 */

export const CAPITAL_START = 500;
export const FLAT_STAKE = 60;
/** Hard ceiling on positions held at the same time (the primary book). */
export const MAX_CONCURRENT = 3;

/**
 * The same signal stream, two bankrolls, different caps. Whether 3 slots is
 * protective or merely slow is not answerable by argument — the looser book
 * takes the trades the tighter one turns away, and a week later the difference
 * is just a number. Paper costs nothing, so we run both instead of guessing.
 */
export const VARIANTS = [
  { id: "c3", maxConcurrent: 3, label: "3 simultáneas" },
  { id: "c5", maxConcurrent: 5, label: "5 simultáneas" },
] as const;

export type VariantId = (typeof VARIANTS)[number]["id"];

/** Rows decided under the pre-dedup rule; kept for the record, not compared. */
export const LEGACY_VARIANT = "legacy-sin-dedup";

/**
 * Prices at which the outcome is no longer in real doubt.
 *
 * Polymarket's oracle settles well after the game is decided, and a paper book
 * that waits for it keeps capital parked in a market with nothing left to
 * learn. A real trader sells the 98¢ ticket and redeploys. That matters here
 * beyond realism: with signals arriving faster than positions close, a slot
 * held by a finished game is a live signal turned away.
 */
export const NEAR_CERTAIN_HIGH = 0.97;
export const NEAR_CERTAIN_LOW = 0.03;

/** True when the market has effectively decided, whichever way it went. */
export function isDecided(currentPrice: number | null | undefined): boolean {
  if (currentPrice === null || currentPrice === undefined) return false;
  return currentPrice >= NEAR_CERTAIN_HIGH || currentPrice <= NEAR_CERTAIN_LOW;
}

/** One bet per market+outcome: two arms agreeing is not two bets. */
export function positionKey(marketId: string, outcome: string | null): string {
  return `${marketId}::${outcome ?? ""}`;
}

/** Categories the reference strategy trades. */
const ELIGIBLE_CATEGORIES: CategoryKey[] = ["esports", "cripto"];
/** The entry band, reusing the matrix's exact cut so the two never drift. */
const ELIGIBLE_BAND = "f55";

/** La Crema mirrors what other arms already copied; counting it double-counts. */
export function isMirrorTrack(track: string): boolean {
  return track === "elite";
}

export interface CandidateTrade {
  id: string;
  track: string;
  marketId: string;
  marketQuestion: string | null;
  outcome: string | null;
  entryPrice: number;
  simulatedPositionSize: number;
  shares: number;
  realizedPnl: number | null;
  status: string;
  depthLadderJson: string | null;
  openedAt: Date;
  closedAt: Date | null;
  resolvedAt: Date | null;
}

export function isEligible(t: Pick<CandidateTrade, "track" | "marketQuestion" | "entryPrice">): boolean {
  if (isMirrorTrack(t.track)) return false;
  if (fineBandKey(t.entryPrice) !== ELIGIBLE_BAND) return false;
  return ELIGIBLE_CATEGORIES.includes(categorizeMarket(t.marketQuestion));
}

/**
 * What OUR stake would have paid, read off the depth ladder measured on the
 * same book at entry. Using the arm's small-size price here would quietly
 * assume size is free, which is the exact assumption this book exists to test.
 */
export function realStakeFill(
  depthLadderJson: string | null,
  stake = FLAT_STAKE,
): { price: number; slippageCents: number } | null {
  const ladder = parseLadder(depthLadderJson);
  if (!ladder) return null;
  const rung = ladder.rungs.find((r) => r.usd === stake);
  if (!rung || !rung.fillable || rung.avgFillPrice === null) return null;
  return { price: rung.avgFillPrice, slippageCents: rung.slippageCents ?? 0 };
}

/**
 * The price the arm got OUT at, derived from its own realized result. Exiting a
 * bigger position could fetch less (we have no bid-side depth), so treating our
 * exit as identical is optimistic — a limit worth stating, not hiding.
 */
export function armExitPrice(t: Pick<CandidateTrade, "simulatedPositionSize" | "shares" | "realizedPnl">): number | null {
  if (t.realizedPnl === null || !t.shares) return null;
  return (t.simulatedPositionSize + t.realizedPnl) / t.shares;
}

/** Our PnL on the flat stake, at our own entry price and the arm's exit price. */
export function settledPnl(entryPrice: number, stake: number, exitPrice: number): number {
  const shares = stake / entryPrice;
  return shares * exitPrice - stake;
}

export interface OpenWindow {
  openedAt: Date;
  closedAt: Date | null;
}

/** How many book positions were live at `t` — the concurrency test. */
export function concurrentAt(windows: OpenWindow[], t: Date): number {
  return windows.filter((w) => w.openedAt <= t && (w.closedAt === null || w.closedAt > t)).length;
}

export type Decision =
  | { take: true; price: number; slippageCents: number }
  | { take: false; reason: "concurrencia" | "capital" | "libro-fino" | "duplicada" };

/**
 * Decide a single signal against the rules, in the order a real account would
 * hit them: room to hold it, cash to fund it, then a book deep enough to fill
 * it. Order matters only for WHICH reason gets recorded, and the reason is the
 * point — it tells us which constraint is actually costing us trades.
 */
export function decide(params: {
  freeCapital: number;
  concurrent: number;
  depthLadderJson: string | null;
  /** True when this exact market+outcome is already held in this book. */
  alreadyHeld?: boolean;
  stake?: number;
  maxConcurrent?: number;
}): Decision {
  const stake = params.stake ?? FLAT_STAKE;
  const maxConcurrent = params.maxConcurrent ?? MAX_CONCURRENT;
  // Checked before the cap: an account already holding this bet would not buy
  // it again regardless of how much room it had. Doubling down because two arms
  // happened to agree concentrates the risk AND burns a slot that a different
  // event could have used — which is exactly how three "diversified" positions
  // quietly become two.
  if (params.alreadyHeld) return { take: false, reason: "duplicada" };
  if (params.concurrent >= maxConcurrent) return { take: false, reason: "concurrencia" };
  if (params.freeCapital < stake) return { take: false, reason: "capital" };
  const fill = realStakeFill(params.depthLadderJson, stake);
  if (!fill) return { take: false, reason: "libro-fino" };
  return { take: true, price: fill.price, slippageCents: fill.slippageCents };
}
