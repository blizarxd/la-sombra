import { describe, expect, it } from "vitest";
import { buildSwingStats } from "@/lib/profiler";
import type { WalletTrade } from "@/lib/adapters/types";

function trade(over: Partial<WalletTrade>): WalletTrade {
  return {
    walletAddress: "0xabc",
    marketId: "m1",
    conditionId: "c1",
    tokenId: "tok1",
    marketQuestion: null,
    marketCategory: null,
    outcome: "Yes",
    side: "BUY",
    price: 0.5,
    sizeUsd: 50, // 100 shares at 0.5
    timestampMs: 1_000,
    transactionHash: null,
    raw: {},
    ...over,
  };
}

describe("buildSwingStats (quota-trader profiling)", () => {
  it("classifies a pure holder: buys, never sells", () => {
    const s = buildSwingStats([trade({}), trade({ marketId: "m2", tokenId: "tok2", timestampMs: 2000 })]);
    expect(s.sellCount).toBe(0);
    expect(s.matchedExitCount).toBe(0);
    expect(s.swingPnl).toBe(0);
    expect(s.earlyExitRate).toBe(0);
    expect(s.style).toBe("holdea");
  });

  it("matches a profitable buy->sell swing FIFO and computes PnL", () => {
    // buy 100 shares at 0.40 ($40), sell 100 shares at 0.65 ($65) -> +$25
    const s = buildSwingStats([
      trade({ side: "BUY", price: 0.4, sizeUsd: 40, timestampMs: 1000 }),
      trade({ side: "SELL", price: 0.65, sizeUsd: 65, timestampMs: 2000 }),
    ]);
    expect(s.sellCount).toBe(1);
    expect(s.matchedExitCount).toBe(1);
    expect(s.swingPnl).toBeCloseTo(25, 5);
    expect(s.swingWinRate).toBe(1);
    expect(s.earlyExitRate).toBeCloseTo(1, 5);
    expect(s.style).toBe("tradea_cuota");
  });

  it("handles a losing swing", () => {
    // buy 100 at 0.60 ($60), sell 100 at 0.45 ($45) -> -$15
    const s = buildSwingStats([
      trade({ side: "BUY", price: 0.6, sizeUsd: 60, timestampMs: 1000 }),
      trade({ side: "SELL", price: 0.45, sizeUsd: 45, timestampMs: 2000 }),
    ]);
    expect(s.swingPnl).toBeCloseTo(-15, 5);
    expect(s.swingWinRate).toBe(0);
  });

  it("only matches sells against buys on the SAME market/outcome", () => {
    const s = buildSwingStats([
      trade({ side: "BUY", marketId: "m1", tokenId: "tok1", timestampMs: 1000 }),
      trade({ side: "SELL", marketId: "m2", tokenId: "tok2", price: 0.9, sizeUsd: 90, timestampMs: 2000 }),
    ]);
    expect(s.sellCount).toBe(1);
    expect(s.matchedExitCount).toBe(0); // sold a position we never saw bought
    expect(s.swingPnl).toBe(0);
  });

  it("partial exit: selling half the position is a mixed style", () => {
    // buy 100 at 0.50, sell 40 at 0.70 -> matched 40 shares, +$8
    const s = buildSwingStats([
      trade({ side: "BUY", price: 0.5, sizeUsd: 50, timestampMs: 1000 }),
      trade({ side: "SELL", price: 0.7, sizeUsd: 28, timestampMs: 2000 }), // 40 shares
    ]);
    expect(s.swingPnl).toBeCloseTo(40 * 0.2, 5);
    expect(s.earlyExitRate).toBeCloseTo(0.4, 5);
    expect(s.style).toBe("mixto");
  });

  it("FIFO: sells consume the OLDEST lot first", () => {
    // lot1: 100 at 0.30; lot2: 100 at 0.60; sell 100 at 0.50 -> matched lot1: +$20
    const s = buildSwingStats([
      trade({ side: "BUY", price: 0.3, sizeUsd: 30, timestampMs: 1000 }),
      trade({ side: "BUY", price: 0.6, sizeUsd: 60, timestampMs: 2000 }),
      trade({ side: "SELL", price: 0.5, sizeUsd: 50, timestampMs: 3000 }),
    ]);
    expect(s.swingPnl).toBeCloseTo(100 * (0.5 - 0.3), 5);
    expect(s.earlyExitRate).toBeCloseTo(0.5, 5);
  });

  it("ignores zero/invalid prices and sorts by timestamp", () => {
    const s = buildSwingStats([
      trade({ side: "SELL", price: 0.8, sizeUsd: 80, timestampMs: 5000 }), // out of order: still after the buy
      trade({ side: "BUY", price: 0.4, sizeUsd: 40, timestampMs: 1000 }),
      trade({ side: "BUY", price: 0, sizeUsd: 0, timestampMs: 500 }), // invalid
    ]);
    expect(s.matchedExitCount).toBe(1);
    expect(s.swingPnl).toBeCloseTo(100 * 0.4, 5);
  });
});
