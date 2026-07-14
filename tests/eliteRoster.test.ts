import { describe, expect, it } from "vitest";
import { ELITE_ROSTER_SIZE, rankEliteRoster } from "@/lib/elite";

describe("rankEliteRoster (🏆 La Crema — top-10-weekly, confirmed winners only)", () => {
  it("ranks by weekly PnL descending", () => {
    const m = new Map([
      ["a", { pnl: 10, n: 2 }],
      ["b", { pnl: 50, n: 5 }],
      ["c", { pnl: 30, n: 3 }],
    ]);
    const ranked = rankEliteRoster(m);
    expect(ranked.map((r) => r.walletAddress)).toEqual(["b", "c", "a"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("excludes wallets with zero or negative weekly PnL — a bad week means falling off, not a free pass", () => {
    const m = new Map([
      ["winner", { pnl: 20, n: 3 }],
      ["loser", { pnl: -5, n: 4 }],
      ["breakeven", { pnl: 0, n: 1 }],
    ]);
    const ranked = rankEliteRoster(m);
    expect(ranked.map((r) => r.walletAddress)).toEqual(["winner"]);
  });

  it("caps at the roster size even with more qualifying winners", () => {
    const m = new Map(Array.from({ length: 15 }, (_, i) => [`w${i}`, { pnl: i + 1, n: 1 }]));
    const ranked = rankEliteRoster(m);
    expect(ranked).toHaveLength(ELITE_ROSTER_SIZE);
    expect(ranked[0].walletAddress).toBe("w14"); // highest pnl first
  });

  it("returns an empty roster when nobody is in the green", () => {
    const m = new Map([["a", { pnl: -1, n: 1 }]]);
    expect(rankEliteRoster(m)).toEqual([]);
  });

  it("respects a custom roster size", () => {
    const m = new Map(Array.from({ length: 5 }, (_, i) => [`w${i}`, { pnl: i + 1, n: 1 }]));
    expect(rankEliteRoster(m, 3)).toHaveLength(3);
  });

  it("rounds weeklyPnl to cents and carries the trade count through", () => {
    const m = new Map([["a", { pnl: 12.3456, n: 7 }]]);
    const ranked = rankEliteRoster(m);
    expect(ranked[0].weeklyPnl).toBe(12.35);
    expect(ranked[0].weeklyTradeCount).toBe(7);
  });
});
