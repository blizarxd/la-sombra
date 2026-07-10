import { describe, expect, it } from "vitest";
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

describe("scoreTrade decisions", () => {
  it("paper-copies a clean signal from a strong wallet", () => {
    const r = scoreTrade(input(), DEFAULT_RULES);
    expect(r.decision).toBe("paper_copy");
    expect(r.hardSkip).toBe(false);
    expect(r.copyScore).toBeGreaterThanOrEqual(DEFAULT_RULES.paperCopyThreshold);
    expect(r.simulatedPositionSize).not.toBeNull();
  });

  it("enforces the 0.82 entry-band ceiling (hard skip)", () => {
    const r = scoreTrade(input({ walletEntryPrice: 0.83, currentAsk: 0.85, currentBid: 0.83 }), DEFAULT_RULES);
    expect(r.decision).toBe("skip");
    expect(r.hardSkip).toBe(true);
    expect(r.risks.join(" ")).toMatch(/entry band/);
  });

  it("enforces the lottery-ticket floor", () => {
    const r = scoreTrade(input({ walletEntryPrice: 0.05, currentAsk: 0.06, currentBid: 0.04 }), DEFAULT_RULES);
    expect(r.decision).toBe("skip");
    expect(r.hardSkip).toBe(true);
  });

  it("skips late entries (price drifted beyond maxPriceDrift)", () => {
    const r = scoreTrade(input({ walletEntryPrice: 0.5, currentAsk: 0.62, currentBid: 0.6 }), DEFAULT_RULES);
    expect(r.decision).toBe("skip");
    expect(r.risks.join(" ")).toMatch(/late entry/);
  });

  it("skips wide spreads", () => {
    const r = scoreTrade(input({ spread: 0.09, currentAsk: 0.55, currentBid: 0.46 }), DEFAULT_RULES);
    expect(r.decision).toBe("skip");
    expect(r.risks.join(" ")).toMatch(/spread/);
  });

  it("skips illiquid markets", () => {
    const r = scoreTrade(input({ liquidity: 120 }), DEFAULT_RULES);
    expect(r.decision).toBe("skip");
    expect(r.risks.join(" ")).toMatch(/liquidity/);
  });

  it("skips weak wallets", () => {
    const r = scoreTrade(
      input({ walletGlobalScore: 30, walletRoiScore: 30, walletConsistencyScore: 30, walletCopyabilityScore: 30 }),
      DEFAULT_RULES,
    );
    expect(r.decision).toBe("skip");
    expect(r.risks.join(" ")).toMatch(/wallet score/);
  });

  it("treats SELL signals as non-copyable in v1", () => {
    const r = scoreTrade(input({ side: "SELL" }), DEFAULT_RULES);
    expect(r.decision).toBe("skip");
  });

  it("skips markets resolving too soon or too far out", () => {
    expect(scoreTrade(input({ timeToResolutionHours: 1 }), DEFAULT_RULES).decision).toBe("skip");
    expect(scoreTrade(input({ timeToResolutionHours: 24 * 90 }), DEFAULT_RULES).decision).toBe("skip");
  });

  it("watchlists a middling-but-clean signal", () => {
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
    expect(r.hardSkip).toBe(false);
    expect(r.decision).toBe("watchlist");
    expect(r.simulatedPositionSize).toBeNull();
  });
});

describe("scoreTrade sizing", () => {
  it("sizes between $5 and $20, larger with more confidence", () => {
    const base = scoreTrade(input(), DEFAULT_RULES);
    const strong = scoreTrade(
      input({
        walletGlobalScore: 95,
        walletRoiScore: 95,
        walletConsistencyScore: 95,
        walletCopyabilityScore: 95,
        walletCategoryScore: 95,
        liquidity: 50000,
        spread: 0.01,
        currentAsk: 0.505,
        currentBid: 0.5,
      }),
      DEFAULT_RULES,
    );
    for (const r of [base, strong]) {
      expect(r.simulatedPositionSize).not.toBeNull();
      expect(r.simulatedPositionSize!).toBeGreaterThanOrEqual(5);
      expect(r.simulatedPositionSize!).toBeLessThanOrEqual(20);
    }
    expect(strong.simulatedPositionSize!).toBeGreaterThan(base.simulatedPositionSize!);
  });
});
