import { describe, expect, it } from "vitest";
import { computeSkipAutopsy, type SkipAutopsyRow } from "@/lib/benchmarks";
import { DEFAULT_RULES } from "@/lib/rules";
import { scoreTrade, type TradeScoreInput } from "@/lib/scoring/tradeScoring";

function input(overrides: Partial<TradeScoreInput> = {}): TradeScoreInput {
  return {
    walletGlobalScore: 75,
    walletRoiScore: 70,
    walletConsistencyScore: 72,
    walletCopyabilityScore: 74,
    walletCategoryScore: 70,
    side: "BUY",
    walletEntryPrice: 0.5,
    currentAsk: 0.52,
    currentBid: 0.5,
    spread: 0.02,
    liquidity: 4000,
    timeToResolutionHours: 72,
    ...overrides,
  };
}

describe("scoreTrade blockedGate (skip autopsy attribution)", () => {
  it("is null when the signal is copied", () => {
    expect(scoreTrade(input(), DEFAULT_RULES).blockedGate).toBeNull();
  });

  it("blames the entry ceiling", () => {
    const r = scoreTrade(input({ walletEntryPrice: 0.83, currentAsk: 0.85, currentBid: 0.83 }), DEFAULT_RULES);
    expect(r.blockedGate).toBe("entry_above_max");
  });

  it("blames the lottery floor", () => {
    const r = scoreTrade(input({ walletEntryPrice: 0.05, currentAsk: 0.06, currentBid: 0.04 }), DEFAULT_RULES);
    expect(r.blockedGate).toBe("entry_below_min");
  });

  it("blames late-entry drift", () => {
    const r = scoreTrade(input({ walletEntryPrice: 0.5, currentAsk: 0.62, currentBid: 0.6 }), DEFAULT_RULES);
    expect(r.blockedGate).toBe("drift");
  });

  it("blames a low wallet score", () => {
    const r = scoreTrade(
      input({ walletGlobalScore: 30, walletRoiScore: 30, walletConsistencyScore: 30, walletCopyabilityScore: 30 }),
      DEFAULT_RULES,
    );
    expect(r.blockedGate).toBe("wallet_score");
  });

  it("flags a watchlisted (below copy threshold) signal", () => {
    const r = scoreTrade(
      input({
        walletGlobalScore: 58,
        walletRoiScore: 45,
        walletConsistencyScore: 40,
        walletCopyabilityScore: 45,
        walletCategoryScore: 40,
        liquidity: 600,
        spread: 0.045,
      }),
      DEFAULT_RULES,
    );
    expect(r.decision).toBe("watchlist");
    expect(r.blockedGate).toBe("below_copy_threshold");
  });
});

describe("computeSkipAutopsy", () => {
  const rows: SkipAutopsyRow[] = [
    // wallet_score gate blocked two big winners and one small loser -> net leak +
    { blockedGate: "wallet_score", hypotheticalPnl: 8 },
    { blockedGate: "wallet_score", hypotheticalPnl: 6 },
    { blockedGate: "wallet_score", hypotheticalPnl: -2 },
    { blockedGate: "wallet_score", hypotheticalPnl: null }, // unknown outcome, counted as blocked only
    // spread gate saved more than it cost -> net negative (doing its job)
    { blockedGate: "spread", hypotheticalPnl: -5 },
    { blockedGate: "spread", hypotheticalPnl: 1 },
    // copied signal must be ignored
    { blockedGate: null, hypotheticalPnl: 10 },
  ];

  it("ranks the biggest leak (positive net) first", () => {
    const gates = computeSkipAutopsy(rows);
    expect(gates[0].gate).toBe("wallet_score");
    expect(gates[0].net).toBe(12); // (8+6) - 2
    expect(gates[0].missedWinners).toBe(14);
    expect(gates[0].avoidedLosers).toBe(2);
    expect(gates[0].blocked).toBe(4);
    expect(gates[0].resolved).toBe(3);
  });

  it("marks a gate doing its job with a negative net", () => {
    const spread = computeSkipAutopsy(rows).find((g) => g.gate === "spread")!;
    expect(spread.net).toBe(-4); // 1 - 5
    expect(spread.avoidedLosers).toBe(5);
  });

  it("ignores copied (unblocked) signals", () => {
    const gates = computeSkipAutopsy(rows);
    expect(gates.some((g) => g.gate === "null" || g.gate === null)).toBe(false);
  });
});
