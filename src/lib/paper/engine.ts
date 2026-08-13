import type { Db } from "@/db/client";
import { paperTrades, pnlSnapshots } from "@/db/schema";
import type { BookLevel, OrderBook } from "@/lib/adapters/types";
import { newId } from "@/lib/ids";
import { eq } from "drizzle-orm";

/**
 * PAPER trading engine. Simulation only:
 * - BUY fills walk the ask side of the real book (you pay the spread).
 * - Exits/marks value the position at best bid (what you could sell for).
 * - If the book can't absorb the simulated size, the fill is rejected
 *   (unfillable) so paper results stay honest.
 *
 * There is intentionally NO function here that submits anything anywhere.
 */

export interface FillSimulation {
  fillable: boolean;
  avgFillPrice: number | null;
  shares: number | null;
  spreadCost: number | null; // (avgFill - mid) * shares, cost of crossing the spread
  reason: string;
}

/** Walk book levels to fill `usdSize` dollars; returns average price paid. */
export function simulateBuyFill(book: OrderBook, usdSize: number): FillSimulation {
  if (!book.asks.length || book.bestAsk === null) {
    return { fillable: false, avgFillPrice: null, shares: null, spreadCost: null, reason: "empty ask side" };
  }
  let remainingUsd = usdSize;
  let sharesAcquired = 0;
  let usdSpent = 0;
  for (const level of book.asks) {
    const levelUsd = level.price * level.size;
    const take = Math.min(remainingUsd, levelUsd);
    sharesAcquired += take / level.price;
    usdSpent += take;
    remainingUsd -= take;
    if (remainingUsd <= 1e-9) break;
  }
  if (remainingUsd > 1e-6) {
    return {
      fillable: false,
      avgFillPrice: null,
      shares: null,
      spreadCost: null,
      reason: `book too thin: only $${usdSpent.toFixed(2)} of $${usdSize.toFixed(2)} fillable`,
    };
  }
  const avgFillPrice = usdSpent / sharesAcquired;
  const mid =
    book.bestBid !== null && book.bestAsk !== null ? (book.bestBid + book.bestAsk) / 2 : book.bestAsk;
  const spreadCost = mid !== null ? (avgFillPrice - mid) * sharesAcquired : null;
  return {
    fillable: true,
    avgFillPrice,
    shares: sharesAcquired,
    spreadCost,
    reason: `filled $${usdSize.toFixed(2)} at avg ${avgFillPrice.toFixed(4)} (best ask ${book.bestAsk.toFixed(4)})`,
  };
}

/**
 * 📏 DEPTH LADDER — how much size the book actually absorbs before the price
 * degrades.
 *
 * The paper book copies at a small fixed size, so every stat we have describes
 * the fill quality AT THAT SIZE. It says nothing about whether the same edge
 * survives a bigger stake: a thin esports book can look perfect for $5 and eat
 * several cents of slippage at $60, which would quietly erase an edge measured
 * in single-digit percent.
 *
 * This walks the SAME book (already in memory, zero extra API calls) at a range
 * of hypothetical sizes and records the average fill for each. It is pure
 * measurement — it never changes what gets copied or at what size.
 */
export const DEPTH_LADDER_SIZES = [5, 10, 20, 40, 60, 100, 150, 250] as const;

export interface DepthRung {
  usd: number;
  fillable: boolean;
  /** Average price paid walking the ask side for this size. */
  avgFillPrice: number | null;
  /** Cents of slippage vs the best ask (0 = filled entirely at the touch). */
  slippageCents: number | null;
}

export interface DepthLadder {
  bestAsk: number | null;
  /** Total USD the whole ask side could absorb. */
  askDepthUsd: number;
  /** Largest ladder size that still fills completely. */
  maxFillableUsd: number;
  rungs: DepthRung[];
}

export function depthLadder(
  book: OrderBook,
  sizes: readonly number[] = DEPTH_LADDER_SIZES,
): DepthLadder {
  const askDepthUsd = book.asks.reduce((sum, l) => sum + l.price * l.size, 0);
  const rungs: DepthRung[] = sizes.map((usd) => {
    const sim = simulateBuyFill(book, usd);
    const slippageCents =
      sim.fillable && sim.avgFillPrice !== null && book.bestAsk !== null
        ? (sim.avgFillPrice - book.bestAsk) * 100
        : null;
    return { usd, fillable: sim.fillable, avgFillPrice: sim.avgFillPrice, slippageCents };
  });
  const fillable = rungs.filter((r) => r.fillable).map((r) => r.usd);
  return {
    bestAsk: book.bestAsk,
    askDepthUsd,
    maxFillableUsd: fillable.length ? Math.max(...fillable) : 0,
    rungs,
  };
}

/** Value of an open long position if sold into the bid side right now. */
export function markToBid(bids: BookLevel[], shares: number): number | null {
  if (!bids.length) return null;
  let remainingShares = shares;
  let usdReceived = 0;
  for (const level of bids) {
    const take = Math.min(remainingShares, level.size);
    usdReceived += take * level.price;
    remainingShares -= take;
    if (remainingShares <= 1e-9) break;
  }
  if (remainingShares > 1e-6) {
    // Thin bid side: value the remainder at the worst touched level (pessimistic).
    const worst = bids[bids.length - 1].price;
    usdReceived += remainingShares * worst;
  }
  return usdReceived;
}

export interface OpenPaperTradeInput {
  decisionJournalId: string;
  walletAddress: string;
  marketId: string;
  tokenId: string | null;
  marketQuestion: string | null;
  outcome: string | null;
  usdSize: number;
  book: OrderBook;
  /** Ledger: "core" (main strategy), "live" (in-play experiment), "trade" (quota-scalper book), "crypto" (crypto book), "combo" (parlay book) or "elite" (top-10-weekly mirror). */
  track?: "core" | "live" | "trade" | "crypto" | "combo" | "elite";
  now?: Date;
}

export interface OpenPaperTradeResult {
  opened: boolean;
  paperTradeId: string | null;
  fill: FillSimulation;
}

/** Open a simulated position (BUY only in v1). Returns unfillable info if the book is too thin. */
export function openPaperTrade(db: Db, input: OpenPaperTradeInput): OpenPaperTradeResult {
  const fill = simulateBuyFill(input.book, input.usdSize);
  if (!fill.fillable || fill.avgFillPrice === null || fill.shares === null) {
    return { opened: false, paperTradeId: null, fill };
  }
  const now = input.now ?? new Date();
  const id = newId();
  db.insert(paperTrades)
    .values({
      id,
      decisionJournalId: input.decisionJournalId,
      walletAddress: input.walletAddress,
      marketId: input.marketId,
      tokenId: input.tokenId,
      marketQuestion: input.marketQuestion,
      outcome: input.outcome,
      side: "BUY",
      entryPrice: fill.avgFillPrice,
      currentPrice: fill.avgFillPrice,
      simulatedPositionSize: input.usdSize,
      shares: fill.shares,
      spreadCostPaid: fill.spreadCost,
      unrealizedPnl: 0,
      realizedPnl: null,
      status: "open",
      track: input.track ?? "core",
      // 📏 Same book, bigger hypothetical sizes. Free (no extra fetch) and the
      // only way to learn whether this edge survives a stake worth trading.
      depthLadderJson: JSON.stringify(depthLadder(input.book)),
      openedAt: now,
    })
    .run();
  return { opened: true, paperTradeId: id, fill };
}

/**
 * Open a simulated position at a KNOWN executed price, for instruments with no
 * public order book (🧩 combos trade via RFQ). Entry = the copied wallet's own
 * fill; shares = usd / price, so a win pays exactly `shares`. The honesty
 * trade-off (we might not get their exact RFQ quote) is labeled in the UI.
 */
export function openPaperTradeAtPrice(
  db: Db,
  input: Omit<OpenPaperTradeInput, "book" | "usdSize"> & { usdSize: number; price: number },
): OpenPaperTradeResult {
  if (!(input.price > 0) || !(input.usdSize > 0)) {
    return {
      opened: false,
      paperTradeId: null,
      fill: { fillable: false, avgFillPrice: null, shares: null, spreadCost: null, reason: "invalid price/size" },
    };
  }
  const now = input.now ?? new Date();
  const id = newId();
  const shares = input.usdSize / input.price;
  db.insert(paperTrades)
    .values({
      id,
      decisionJournalId: input.decisionJournalId,
      walletAddress: input.walletAddress,
      marketId: input.marketId,
      tokenId: input.tokenId,
      marketQuestion: input.marketQuestion,
      outcome: input.outcome,
      side: "BUY",
      entryPrice: input.price,
      currentPrice: input.price,
      simulatedPositionSize: input.usdSize,
      shares,
      spreadCostPaid: null, // no public book to measure a spread against
      unrealizedPnl: 0,
      realizedPnl: null,
      status: "open",
      track: input.track ?? "core",
      openedAt: now,
    })
    .run();
  return {
    opened: true,
    paperTradeId: id,
    fill: {
      fillable: true,
      avgFillPrice: input.price,
      shares,
      spreadCost: null,
      reason: `copied at the wallet's executed price ${input.price.toFixed(4)} (no public book)`,
    },
  };
}

export interface PaperTradeRow {
  id: string;
  entryPrice: number;
  shares: number;
  simulatedPositionSize: number;
}

/** Mark an open paper trade against the current book and record a pnl snapshot. */
export function markPaperTrade(
  db: Db,
  trade: PaperTradeRow,
  book: OrderBook,
  now: Date = new Date(),
): { price: number; unrealizedPnl: number } | null {
  const exitValue = markToBid(book.bids, trade.shares);
  const price = book.bestBid;
  if (exitValue === null || price === null) return null;
  const unrealizedPnl = exitValue - trade.simulatedPositionSize;
  db.update(paperTrades)
    .set({ currentPrice: price, unrealizedPnl })
    .where(eq(paperTrades.id, trade.id))
    .run();
  db.insert(pnlSnapshots)
    .values({ id: newId(), paperTradeId: trade.id, price, pnl: unrealizedPnl, collectedAt: now })
    .run();
  return { price, unrealizedPnl };
}

/**
 * Close an open paper trade early by simulating a sell into the current bids
 * (copying the tracked wallet's exit). Realized PnL = what the bids pay minus
 * what we spent. Returns null if the bid side is empty (can't price the exit).
 */
export function closePaperTrade(
  db: Db,
  trade: PaperTradeRow,
  book: OrderBook,
  now: Date = new Date(),
): { realizedPnl: number; exitPrice: number } | null {
  const exitValue = markToBid(book.bids, trade.shares);
  const price = book.bestBid;
  if (exitValue === null || price === null) return null;
  const realizedPnl = exitValue - trade.simulatedPositionSize;
  db.update(paperTrades)
    .set({
      status: "closed",
      realizedPnl,
      unrealizedPnl: null,
      currentPrice: price,
      closedAt: now,
    })
    .where(eq(paperTrades.id, trade.id))
    .run();
  db.insert(pnlSnapshots)
    .values({ id: newId(), paperTradeId: trade.id, price, pnl: realizedPnl, collectedAt: now })
    .run();
  return { realizedPnl, exitPrice: price };
}

/**
 * Close an open paper trade at a KNOWN exit price (🧩 combo cash-outs: the
 * copied wallet SOLD its combo back via RFQ and we copy the exit at their
 * executed price — there is no public bid side to walk).
 */
export function closePaperTradeAtPrice(
  db: Db,
  trade: PaperTradeRow,
  price: number,
  now: Date = new Date(),
): { realizedPnl: number; exitPrice: number } {
  const realizedPnl = trade.shares * price - trade.simulatedPositionSize;
  db.update(paperTrades)
    .set({
      status: "closed",
      realizedPnl,
      unrealizedPnl: null,
      currentPrice: price,
      closedAt: now,
    })
    .where(eq(paperTrades.id, trade.id))
    .run();
  db.insert(pnlSnapshots)
    .values({ id: newId(), paperTradeId: trade.id, price, pnl: realizedPnl, collectedAt: now })
    .run();
  return { realizedPnl, exitPrice: price };
}

/** Resolve a paper trade when its market resolves. Payout: 1 if won, 0 if lost. */
export function resolvePaperTrade(
  db: Db,
  trade: PaperTradeRow,
  won: boolean,
  now: Date = new Date(),
): { realizedPnl: number } {
  const payout = won ? trade.shares * 1 : 0;
  const realizedPnl = payout - trade.simulatedPositionSize;
  db.update(paperTrades)
    .set({
      status: "resolved",
      realizedPnl,
      unrealizedPnl: null,
      currentPrice: won ? 1 : 0,
      resolvedAt: now,
    })
    .where(eq(paperTrades.id, trade.id))
    .run();
  db.insert(pnlSnapshots)
    .values({ id: newId(), paperTradeId: trade.id, price: won ? 1 : 0, pnl: realizedPnl, collectedAt: now })
    .run();
  return { realizedPnl };
}
