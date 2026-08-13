import { describe, expect, it } from "vitest";
import { analyzeDepth, parseLadder } from "@/lib/depth";
import type { DepthLadder } from "@/lib/paper/engine";

function ladder(rungs: { usd: number; fillable: boolean; slippageCents: number | null }[]): DepthLadder {
  return {
    bestAsk: 0.57,
    askDepthUsd: 500,
    maxFillableUsd: Math.max(0, ...rungs.filter((r) => r.fillable).map((r) => r.usd)),
    rungs: rungs.map((r) => ({ ...r, avgFillPrice: 0.57 + (r.slippageCents ?? 0) / 100 })),
  };
}

describe("analyzeDepth", () => {
  it("separates fill rate from slippage per size", () => {
    const report = analyzeDepth([
      {
        entryPrice: 0.5,
        ladder: ladder([
          { usd: 5, fillable: true, slippageCents: 0 },
          { usd: 60, fillable: true, slippageCents: 2 },
        ]),
      },
      {
        entryPrice: 0.5,
        ladder: ladder([
          { usd: 5, fillable: true, slippageCents: 0 },
          { usd: 60, fillable: false, slippageCents: null },
        ]),
      },
    ]);
    const small = report.rungs.find((r) => r.usd === 5)!;
    const big = report.rungs.find((r) => r.usd === 60)!;
    expect(small.fillRate).toBe(1);
    expect(big.fillRate).toBe(0.5); // one of two books could not absorb $60
    expect(big.medianSlippageCents).toBeCloseTo(2, 6);
  });

  it("expresses slippage as a share of the position so it compares to ROI", () => {
    // 2c of slippage on a 50c entry costs 4% of the stake.
    const report = analyzeDepth([
      { entryPrice: 0.5, ladder: ladder([{ usd: 60, fillable: true, slippageCents: 2 }]) },
    ]);
    expect(report.rungs[0].medianCostPct).toBeCloseTo(4, 6);
  });

  it("ignores unfillable rungs when averaging slippage", () => {
    const report = analyzeDepth([
      { entryPrice: 0.5, ladder: ladder([{ usd: 60, fillable: false, slippageCents: null }]) },
    ]);
    expect(report.rungs[0].medianSlippageCents).toBeNull();
    expect(report.rungs[0].fillRate).toBe(0);
  });

  it("reports the bad-case fill, not just the typical one", () => {
    const inputs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 9].map((c) => ({
      entryPrice: 0.5,
      ladder: ladder([{ usd: 60, fillable: true, slippageCents: c }]),
    }));
    const report = analyzeDepth(inputs);
    expect(report.rungs[0].medianSlippageCents).toBeCloseTo(1, 6);
    expect(report.rungs[0].p90SlippageCents!).toBeGreaterThan(1);
  });
});

describe("parseLadder", () => {
  it("returns null for trades captured before the instrument existed", () => {
    expect(parseLadder(null)).toBeNull();
  });
  it("returns null instead of throwing on corrupt json", () => {
    expect(parseLadder("{not json")).toBeNull();
  });
  it("rejects json without rungs", () => {
    expect(parseLadder('{"bestAsk":0.5}')).toBeNull();
  });
});
