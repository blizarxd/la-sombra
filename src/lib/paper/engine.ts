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
  /** Ledger: "core" (main strategy), "live" (in-play experiment), "trade" (quota-scalper book) or "crypto" (crypto book). */
  track?: "core" | "live" | "trade" | "crypto";
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
      openedAt: now,
    })
    .run();
  return { opened: true, paperTradeId: id, fill };
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
