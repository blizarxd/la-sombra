import { describe, expect, it } from "vitest";
import { isEligible, realExitValue } from "@/lib/criptoBook";

describe("criptoBook isEligible", () => {
  const base = { track: "core", marketQuestion: "Bitcoin Up or Down - 3PM", entryPrice: 0.57 };

  it("takes crypto markets — the only entry filter with a positive floor", () => {
    expect(isEligible(base)).toBe(true);
    expect(isEligible({ ...base, marketQuestion: "Will Ethereum close above $4000?" })).toBe(true);
  });

  it("rejects esports, which ran flat despite being 3 of every 4 trades", () => {
    expect(isEligible({ ...base, marketQuestion: "LoL: T1 vs Gen.G (BO3)" })).toBe(false);
  });

  it("rejects deportes", () => {
    expect(isEligible({ ...base, marketQuestion: "Lakers vs Celtics" })).toBe(false);
  });

  it("rejects La Crema, whose copies mirror the other arms", () => {
    expect(isEligible({ ...base, track: "elite" })).toBe(false);
  });

  it("rejects prices outside 55-59c — the band the finding was measured in", () => {
    // The first run of this book had no band filter and took 36c, 40c and 63c
    // entries; the result inverted from +35.5% to -15.2%.
    expect(isEligible({ ...base, entryPrice: 0.36 })).toBe(false);
    expect(isEligible({ ...base, entryPrice: 0.4 })).toBe(false);
    expect(isEligible({ ...base, entryPrice: 0.634 })).toBe(false);
    expect(isEligible({ ...base, entryPrice: 0.54 })).toBe(false);
  });

  it("accepts both edges of the band", () => {
    expect(isEligible({ ...base, entryPrice: 0.55 })).toBe(true);
    expect(isEligible({ ...base, entryPrice: 0.599 })).toBe(true);
  });
});

describe("realExitValue — what selling actually pays", () => {
  // 100 shares at 90c, then 100 at 80c, then 100 at 50c.
  const levels = JSON.stringify([
    { price: 0.9, size: 100 },
    { price: 0.8, size: 100 },
    { price: 0.5, size: 100 },
  ]);

  it("pays the touch price when the top level absorbs the whole position", () => {
    expect(realExitValue(levels, 50)).toBeCloseTo(50 * 0.9, 6);
  });

  it("walks down the book when the position is bigger than the touch", () => {
    // 150 shares = 100 @ 0.90 + 50 @ 0.80 = 90 + 40 = 130, NOT 150 * 0.90 = 135.
    expect(realExitValue(levels, 150)).toBeCloseTo(130, 6);
  });

  it("charges more the deeper the sell has to reach", () => {
    const small = realExitValue(levels, 100)! / 100;
    const big = realExitValue(levels, 250)! / 250;
    expect(big).toBeLessThan(small);
  });

  it("returns null when there is no sell-side snapshot — unknown, not free", () => {
    // Substituting the touch price here is exactly the flattering assumption
    // this function exists to remove.
    expect(realExitValue(null, 100)).toBeNull();
  });

  it("returns null rather than throwing on corrupt json", () => {
    expect(realExitValue("{not json", 100)).toBeNull();
  });

  it("returns null on an empty book", () => {
    expect(realExitValue("[]", 100)).toBeNull();
  });
});
