import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { paperTrades, pnlSnapshots } from "@/db/schema";
import type { OrderBook } from "@/lib/adapters/types";
import {
  DEPTH_LADDER_SIZES,
  depthLadder,
  markPaperTrade,
  markToBid,
  openPaperTrade,
  resolvePaperTrade,
  simulateBuyFill,
} from "@/lib/paper/engine";
import { testDb } from "./helpers/db";

function book(overrides: Partial<OrderBook> = {}): OrderBook {
  const bids = overrides.bids ?? [
    { price: 0.5, size: 100 },
    { price: 0.49, size: 200 },
  ];
  const asks = overrides.asks ?? [
    { price: 0.52, size: 100 },
    { price: 0.53, size: 200 },
  ];
  return {
    tokenId: "tok-1",
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    spread: bids[0] && asks[0] ? asks[0].price - bids[0].price : null,
    raw: {},
    ...overrides,
  };
}

describe("simulateBuyFill", () => {
  it("fills at best ask when the level is deep enough", () => {
    const fill = simulateBuyFill(book(), 10);
    expect(fill.fillable).toBe(true);
    expect(fill.avgFillPrice).toBeCloseTo(0.52, 6);
    expect(fill.shares).toBeCloseTo(10 / 0.52, 4);
  });
  it("walks multiple levels and averages the price up", () => {
    const fill = simulateBuyFill(book({ asks: [{ price: 0.52, size: 10 }, { price: 0.6, size: 500 }] }), 15);
    expect(fill.fillable).toBe(true);
    expect(fill.avgFillPrice!).toBeGreaterThan(0.52);
    expect(fill.avgFillPrice!).toBeLessThan(0.6);
  });
  it("rejects when the book is too thin (unfillable, skip)", () => {
    const fill = simulateBuyFill(book({ asks: [{ price: 0.52, size: 5 }] }), 20);
    expect(fill.fillable).toBe(false);
    expect(fill.reason).toMatch(/too thin/);
  });
  it("rejects an empty ask side", () => {
    expect(simulateBuyFill(book({ asks: [] }), 10).fillable).toBe(false);
  });
  it("accounts for spread cost vs mid", () => {
    const fill = simulateBuyFill(book(), 10);
    // mid = 0.51, paid 0.52 -> cost = 0.01 * shares
    expect(fill.spreadCost).toBeCloseTo(0.01 * (10 / 0.52), 4);
  });
});

describe("markToBid", () => {
  it("values a position against bid depth, pessimistic on the remainder", () => {
    const value = markToBid([{ price: 0.5, size: 10 }, { price: 0.45, size: 5 }], 20);
    // 10 @ .50 + 5 @ .45 + 5 remaining @ worst (.45)
    expect(value).toBeCloseTo(10 * 0.5 + 5 * 0.45 + 5 * 0.45, 6);
  });
  it("returns null with no bids", () => {
    expect(markToBid([], 10)).toBeNull();
  });
});

describe("paper trade lifecycle (create -> hourly mark -> resolve)", () => {
  it("creates an open paper trade with a realistic entry", () => {
    const db = testDb();
    const res = openPaperTrade(db, {
      decisionJournalId: "dec-1",
      walletAddress: "0xabc",
      marketId: "0xcond",
      tokenId: "tok-1",
      marketQuestion: "Test?",
      outcome: "Yes",
      usdSize: 10,
      book: book(),
    });
    expect(res.opened).toBe(true);
    const row = db.select().from(paperTrades).where(eq(paperTrades.id, res.paperTradeId!)).get()!;
    expect(row.status).toBe("open");
    expect(row.entryPrice).toBeCloseTo(0.52, 6);
    expect(row.simulatedPositionSize).toBe(10);
    expect(row.shares).toBeCloseTo(10 / 0.52, 4);
  });

  it("does NOT create a trade when unfillable", () => {
    const db = testDb();
    const res = openPaperTrade(db, {
      decisionJournalId: "dec-2",
      walletAddress: "0xabc",
      marketId: "0xcond",
      tokenId: "tok-1",
      marketQuestion: "Thin?",
      outcome: "Yes",
      usdSize: 20,
      book: book({ asks: [{ price: 0.52, size: 3 }] }),
    });
    expect(res.opened).toBe(false);
    expect(db.select().from(paperTrades).all()).toHaveLength(0);
  });

  it("hourly mark values at the BID and records a pnl snapshot", () => {
    const db = testDb();
    const open = openPaperTrade(db, {
      decisionJournalId: "dec-3",
      walletAddress: "0xabc",
      marketId: "0xcond",
      tokenId: "tok-1",
      marketQuestion: "Mark?",
      outcome: "Yes",
      usdSize: 10,
      book: book(),
    });
    const row = db.select().from(paperTrades).where(eq(paperTrades.id, open.paperTradeId!)).get()!;
    // price rallies: bid now 0.60
    const mark = markPaperTrade(db, row, book({ bids: [{ price: 0.6, size: 500 }], asks: [{ price: 0.62, size: 500 }], bestBid: 0.6, bestAsk: 0.62 }));
    expect(mark).not.toBeNull();
    expect(mark!.price).toBe(0.6);
    const shares = 10 / 0.52;
    expect(mark!.unrealizedPnl).toBeCloseTo(shares * 0.6 - 10, 4);
    const snaps = db.select().from(pnlSnapshots).all();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].pnl).toBeCloseTo(mark!.unrealizedPnl, 6);
    const updated = db.select().from(paperTrades).where(eq(paperTrades.id, row.id)).get()!;
    expect(updated.unrealizedPnl).toBeCloseTo(mark!.unrealizedPnl, 6);
  });

  it("resolution pays $1 per share on a win, $0 on a loss", () => {
    const db = testDb();
    const mk = (id: string) =>
      openPaperTrade(db, {
        decisionJournalId: id,
        walletAddress: "0xabc",
        marketId: "0xcond",
        tokenId: "tok-1",
        marketQuestion: "Resolve?",
        outcome: "Yes",
        usdSize: 10,
        book: book(),
      });
    const winner = mk("dec-w");
    const loser = mk("dec-l");
    const shares = 10 / 0.52;

    const wRow = db.select().from(paperTrades).where(eq(paperTrades.id, winner.paperTradeId!)).get()!;
    const won = resolvePaperTrade(db, wRow, true);
    expect(won.realizedPnl).toBeCloseTo(shares - 10, 4);

    const lRow = db.select().from(paperTrades).where(eq(paperTrades.id, loser.paperTradeId!)).get()!;
    const lost = resolvePaperTrade(db, lRow, false);
    expect(lost.realizedPnl).toBeCloseTo(-10, 6);

    const wFinal = db.select().from(paperTrades).where(eq(paperTrades.id, wRow.id)).get()!;
    expect(wFinal.status).toBe("resolved");
    expect(wFinal.currentPrice).toBe(1);
    expect(wFinal.resolvedAt).not.toBeNull();
  });
});

describe("depthLadder", () => {
  it("reports zero slippage while a single level absorbs the size", () => {
    // Best ask holds 100 shares @ 0.52 = $52 of depth, so $20 never leaves it.
    const ladder = depthLadder(book(), [20]);
    expect(ladder.rungs[0].fillable).toBe(true);
    expect(ladder.rungs[0].avgFillPrice).toBeCloseTo(0.52, 6);
    expect(ladder.rungs[0].slippageCents).toBeCloseTo(0, 6);
  });

  it("shows slippage growing once the size walks past the touch", () => {
    const thin = book({ asks: [{ price: 0.55, size: 20 }, { price: 0.62, size: 500 }] });
    const ladder = depthLadder(thin, [5, 60]);
    const [small, big] = ladder.rungs;
    expect(small.slippageCents).toBeCloseTo(0, 6); // $5 fits inside $11 of touch
    expect(big.slippageCents!).toBeGreaterThan(0); // $60 must eat the 0.62 level
    expect(big.avgFillPrice!).toBeGreaterThan(small.avgFillPrice!);
  });

  it("marks rungs beyond the book's total depth as unfillable", () => {
    const shallow = book({ asks: [{ price: 0.55, size: 20 }] }); // $11 total
    const ladder = depthLadder(shallow, [5, 60]);
    expect(ladder.rungs[0].fillable).toBe(true);
    expect(ladder.rungs[1].fillable).toBe(false);
    expect(ladder.maxFillableUsd).toBe(5);
    expect(ladder.askDepthUsd).toBeCloseTo(11, 6);
  });

  it("is stored on the trade so depth can be sliced later", () => {
    const db = testDb();
    const opened = openPaperTrade(db, {
      decisionJournalId: "dec-depth",
      walletAddress: "0xw",
      marketId: "0xcond",
      tokenId: "tok-1",
      marketQuestion: "Deep?",
      outcome: "Yes",
      usdSize: 5,
      book: book(),
    });
    const row = db.select().from(paperTrades).where(eq(paperTrades.id, opened.paperTradeId!)).get()!;
    const parsed = JSON.parse(row.depthLadderJson!);
    expect(parsed.rungs.length).toBe(DEPTH_LADDER_SIZES.length);
    expect(parsed.bestAsk).toBeCloseTo(0.52, 6);
  });
});
