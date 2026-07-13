import { describe, expect, it } from "vitest";
import { shouldStopLoss } from "@/lib/paper/engine";

describe("shouldStopLoss (paper risk overlay)", () => {
  it("triggers when the mark has dropped at least the stop fraction", () => {
    // cost 10, mark 5 = down 50% -> stop at 0.5 triggers
    expect(shouldStopLoss(10, 5, 0.5)).toBe(true);
    expect(shouldStopLoss(10, 4, 0.5)).toBe(true);
  });

  it("does not trigger above the stop threshold", () => {
    // cost 10, mark 6 = down 40% -> stop at 0.5 does not trigger
    expect(shouldStopLoss(10, 6, 0.5)).toBe(false);
  });

  it("is disabled when stopLossPct is undefined or 0", () => {
    expect(shouldStopLoss(10, 1, undefined)).toBe(false);
    expect(shouldStopLoss(10, 1, 0)).toBe(false);
  });

  it("never triggers on a winning position", () => {
    expect(shouldStopLoss(10, 12, 0.5)).toBe(false);
  });

  it("guards against zero/negative cost", () => {
    expect(shouldStopLoss(0, -5, 0.5)).toBe(false);
  });
});
