import { describe, expect, it } from "vitest";
import {
  armExitPrice,
  concurrentAt,
  decide,
  isEligible,
  positionKey,
  realStakeFill,
  settledPnl,
} from "@/lib/capitalBook";

function ladderJson(rungs: { usd: number; fillable: boolean; avgFillPrice: number | null; slippageCents: number | null }[]) {
  return JSON.stringify({ bestAsk: 0.57, askDepthUsd: 999, maxFillableUsd: 250, rungs });
}
const deepBook = ladderJson([
  { usd: 60, fillable: true, avgFillPrice: 0.58, slippageCents: 1 },
]);
const thinBook = ladderJson([{ usd: 60, fillable: false, avgFillPrice: null, slippageCents: null }]);

describe("isEligible", () => {
  const base = { track: "core", marketQuestion: "Dota 2: Team A vs Team B (BO3)", entryPrice: 0.57 };
  it("takes esports inside the band", () => {
    expect(isEligible(base)).toBe(true);
  });
  it("takes crypto inside the band", () => {
    expect(isEligible({ ...base, marketQuestion: "Bitcoin Up or Down - 3PM" })).toBe(true);
  });
  it("rejects prices outside the band", () => {
    expect(isEligible({ ...base, entryPrice: 0.62 })).toBe(false);
    expect(isEligible({ ...base, entryPrice: 0.54 })).toBe(false);
  });
  it("rejects other categories", () => {
    expect(isEligible({ ...base, marketQuestion: "Will the Fed cut rates?" })).toBe(false);
  });
  it("rejects La Crema, whose copies mirror the other arms", () => {
    // Counting it would credit one real-world signal to the bankroll twice.
    expect(isEligible({ ...base, track: "elite" })).toBe(false);
  });
});

describe("realStakeFill", () => {
  it("prices the stake off the measured ladder, not the arm's small fill", () => {
    expect(realStakeFill(deepBook)!.price).toBeCloseTo(0.58, 6);
  });
  it("returns null when the book cannot absorb the stake", () => {
    expect(realStakeFill(thinBook)).toBeNull();
  });
  it("returns null for trades opened before the ladder existed", () => {
    expect(realStakeFill(null)).toBeNull();
  });
});

describe("concurrentAt", () => {
  const w = (o: string, c: string | null) => ({ openedAt: new Date(o), closedAt: c ? new Date(c) : null });
  it("counts only positions live at that instant", () => {
    const windows = [
      w("2026-08-13T10:00:00Z", "2026-08-13T11:00:00Z"),
      w("2026-08-13T10:30:00Z", null),
    ];
    expect(concurrentAt(windows, new Date("2026-08-13T10:45:00Z"))).toBe(2);
    expect(concurrentAt(windows, new Date("2026-08-13T11:30:00Z"))).toBe(1);
    expect(concurrentAt(windows, new Date("2026-08-13T09:00:00Z"))).toBe(0);
  });
  it("frees the slot at the exact close instant", () => {
    const windows = [w("2026-08-13T10:00:00Z", "2026-08-13T11:00:00Z")];
    expect(concurrentAt(windows, new Date("2026-08-13T11:00:00Z"))).toBe(0);
  });
});

describe("decide", () => {
  const ok = { freeCapital: 500, concurrent: 0, depthLadderJson: deepBook };
  it("takes a signal with room, cash and depth", () => {
    expect(decide(ok)).toEqual({ take: true, price: 0.58, slippageCents: 1 });
  });
  it("blocks on the concurrency cap first", () => {
    expect(decide({ ...ok, concurrent: 3 })).toEqual({ take: false, reason: "concurrencia" });
  });
  it("blocks when the bankroll cannot fund the stake", () => {
    expect(decide({ ...ok, freeCapital: 59 })).toEqual({ take: false, reason: "capital" });
  });
  it("blocks when the book is too thin for real size", () => {
    expect(decide({ ...ok, depthLadderJson: thinBook })).toEqual({ take: false, reason: "libro-fino" });
  });
});

describe("PnL on the flat stake", () => {
  it("recovers the arm's exit price from its realized result", () => {
    // $5 bought 10 shares at 50c and returned $8 → exited at 80c.
    expect(armExitPrice({ simulatedPositionSize: 5, shares: 10, realizedPnl: 3 })).toBeCloseTo(0.8, 6);
  });
  it("is null while the arm trade is still open", () => {
    expect(armExitPrice({ simulatedPositionSize: 5, shares: 10, realizedPnl: null })).toBeNull();
  });
  it("pays out the flat stake at our own entry price", () => {
    // $60 at 60c = 100 shares; resolving at $1 returns $100, so +$40.
    expect(settledPnl(0.6, 60, 1)).toBeCloseTo(40, 6);
  });
  it("loses the whole stake when the position resolves worthless", () => {
    expect(settledPnl(0.6, 60, 0)).toBeCloseTo(-60, 6);
  });
  it("makes a worse entry produce a worse result on the same exit", () => {
    // The whole reason we price off the ladder: slippage must actually cost.
    expect(settledPnl(0.58, 60, 1)).toBeGreaterThan(settledPnl(0.59, 60, 1));
  });
});

describe("dedup: one bet per market, agreement counted not doubled", () => {
  const ok = { freeCapital: 500, concurrent: 0, depthLadderJson: deepBook };

  it("refuses a second position on a bet already held", () => {
    // Two arms copying one match is agreement, not two opportunities.
    expect(decide({ ...ok, alreadyHeld: true })).toEqual({ take: false, reason: "duplicada" });
  });

  it("checks the duplicate before the cap, so the reason is the real one", () => {
    // With room to spare it must still say "duplicada", not "concurrencia".
    expect(decide({ ...ok, alreadyHeld: true, concurrent: 0 })).toEqual({ take: false, reason: "duplicada" });
  });

  it("still blocks a duplicate when the book is also full", () => {
    expect(decide({ ...ok, alreadyHeld: true, concurrent: 5 })).toEqual({ take: false, reason: "duplicada" });
  });

  it("keys a position by market AND outcome — opposite sides are distinct bets", () => {
    expect(positionKey("m1", "Yes")).not.toBe(positionKey("m1", "No"));
    expect(positionKey("m1", "Yes")).toBe(positionKey("m1", "Yes"));
  });

  it("honours a per-variant cap so the 3 and 5 books diverge", () => {
    const four = { ...ok, concurrent: 4 };
    expect(decide({ ...four, maxConcurrent: 3 })).toEqual({ take: false, reason: "concurrencia" });
    expect(decide({ ...four, maxConcurrent: 5 }).take).toBe(true);
  });
});
