import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@/lib/rules";
import {
  oneHitWonderPenalty,
  scoreConsistency,
  scoreCopyability,
  scoreRoi,
  scoreWallet,
  statusForScore,
  type ResolvedTradeLike,
} from "@/lib/scoring/walletScoring";

const DAY = 24 * 3600 * 1000;
const now = Date.now();

function trade(overrides: Partial<ResolvedTradeLike> = {}): ResolvedTradeLike {
  return {
    pnl: 10,
    category: "Crypto",
    timestampMs: now,
    liquidity: 3000,
    spread: 0.02,
    entryDrift: 0.01,
    entryPrice: 0.5,
    sizeUsd: 100,
    ...overrides,
  };
}

describe("scoreRoi", () => {
  it("maps break-even to the neutral 40 band", () => {
    expect(scoreRoi(0)).toBeCloseTo(40, 0);
  });
  it("rewards strong positive ROI", () => {
    expect(scoreRoi(0.3)).toBeGreaterThan(85);
  });
  it("punishes negative ROI hard", () => {
    expect(scoreRoi(-0.4)).toBeLessThan(10);
    expect(scoreRoi(-0.6)).toBe(0);
  });
  it("returns 0 for unknown ROI", () => {
    expect(scoreRoi(null)).toBe(0);
  });
});

describe("scoreConsistency", () => {
  it("rewards profit spread across many weeks", () => {
    const spread = [0, 1, 2, 3].flatMap((w) =>
      [0, 1, 2].map((i) => trade({ pnl: 10, timestampMs: now - w * 7 * DAY - i * DAY })),
    );
    const concentrated = [
      ...[0, 1, 2].map((i) => trade({ pnl: 100, timestampMs: now - i * DAY })),
      ...[1, 2, 3].flatMap((w) => [trade({ pnl: -5, timestampMs: now - w * 7 * DAY })]),
    ];
    expect(scoreConsistency(spread, 5)).toBeGreaterThan(scoreConsistency(concentrated, 5));
  });
  it("penalizes wallets with too few resolved trades", () => {
    const few = [trade(), trade()];
    const many = Array.from({ length: 10 }, (_, i) => trade({ timestampMs: now - i * 3 * DAY }));
    expect(scoreConsistency(few, 5)).toBeLessThan(scoreConsistency(many, 5));
  });
  it("returns 0 with no trades", () => {
    expect(scoreConsistency([], 5)).toBe(0);
  });
});

describe("oneHitWonderPenalty", () => {
  it("is zero when profit is well distributed", () => {
    const trades = Array.from({ length: 10 }, () => trade({ pnl: 10 }));
    expect(oneHitWonderPenalty(trades, 0.5)).toBe(0);
  });
  it("is high when one trade made nearly all the profit", () => {
    const trades = [trade({ pnl: 95 }), ...Array.from({ length: 9 }, () => trade({ pnl: 0.5 }))];
    expect(oneHitWonderPenalty(trades, 0.5)).toBeGreaterThan(80);
  });
  it("ignores unprofitable wallets (ROI already covers them)", () => {
    const trades = [trade({ pnl: 50 }), trade({ pnl: -80 })];
    expect(oneHitWonderPenalty(trades, 0.5)).toBe(0);
  });
  it("scales with the share above the threshold", () => {
    const at60 = [trade({ pnl: 60 }), trade({ pnl: 40 })];
    const at90 = [trade({ pnl: 90 }), trade({ pnl: 10 })];
    expect(oneHitWonderPenalty(at90, 0.5)).toBeGreaterThan(oneHitWonderPenalty(at60, 0.5));
  });
});

describe("scoreCopyability", () => {
  it("scores liquid, tight, in-band wallets far above illiquid wide ones", () => {
    const good = Array.from({ length: 10 }, () =>
      trade({ liquidity: 8000, spread: 0.015, entryDrift: 0.005, entryPrice: 0.5 }),
    );
    const bad = Array.from({ length: 10 }, () =>
      trade({ liquidity: 80, spread: 0.12, entryDrift: 0.15, entryPrice: 0.95 }),
    );
    const goodScore = scoreCopyability(good, DEFAULT_RULES);
    const badScore = scoreCopyability(bad, DEFAULT_RULES);
    expect(goodScore).toBeGreaterThan(70);
    expect(badScore).toBeLessThan(30);
  });
  it("penalizes entries outside the copyable price band", () => {
    const inBand = Array.from({ length: 8 }, () => trade({ entryPrice: 0.5 }));
    const outBand = Array.from({ length: 8 }, () => trade({ entryPrice: 0.95 }));
    expect(scoreCopyability(inBand, DEFAULT_RULES)).toBeGreaterThan(scoreCopyability(outBand, DEFAULT_RULES));
  });
});

describe("scoreWallet + statusForScore", () => {
  it("tracks a strong consistent wallet and ignores a one-hit wonder", () => {
    const steady = scoreWallet(
      {
        roi30d: 0.25,
        tradeCount30d: 40,
        resolvedTrades: Array.from({ length: 20 }, (_, i) =>
          trade({ pnl: i % 3 === 0 ? -5 : 12, timestampMs: now - i * 1.5 * DAY }),
        ),
      },
      DEFAULT_RULES,
    );
    const lucky = scoreWallet(
      {
        roi30d: 0.9,
        tradeCount30d: 12,
        resolvedTrades: [
          trade({ pnl: 500, timestampMs: now - 20 * DAY, liquidity: 150 }),
          ...Array.from({ length: 8 }, (_, i) => trade({ pnl: -8, timestampMs: now - i * DAY, liquidity: 150 })),
        ],
      },
      DEFAULT_RULES,
    );
    expect(steady.globalScore).toBeGreaterThan(lucky.globalScore);
    expect(lucky.oneHitWonderPenalty).toBeGreaterThan(50);
    expect(statusForScore(steady.globalScore, DEFAULT_RULES)).toBe("track");
    expect(statusForScore(lucky.globalScore, DEFAULT_RULES)).not.toBe("track");
  });
  it("finds the best category", () => {
    const res = scoreWallet(
      {
        roi30d: 0.1,
        tradeCount30d: 12,
        resolvedTrades: [
          ...Array.from({ length: 5 }, (_, i) => trade({ category: "Politics", pnl: 20, timestampMs: now - i * DAY })),
          ...Array.from({ length: 4 }, (_, i) => trade({ category: "Sports", pnl: -10, timestampMs: now - i * DAY })),
        ],
      },
      DEFAULT_RULES,
    );
    expect(res.bestCategory).toBe("Politics");
    expect(res.categoryStrengths.Politics.winRate).toBe(1);
  });
});
