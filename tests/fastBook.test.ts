import { describe, expect, it } from "vitest";
import { FAST_RESOLVE_HOURS, isEligible } from "@/lib/fastBook";

describe("fastBook isEligible", () => {
  const base = {
    track: "core",
    marketQuestion: "LoL: Shifters vs SK Gaming - Game 2 Winner",
    expectedResolutionHours: 0.5,
  };

  it("takes esports scheduled inside the fast window", () => {
    expect(isEligible(base)).toBe(true);
  });

  it("takes deportes scheduled inside the fast window", () => {
    expect(isEligible({ ...base, marketQuestion: "Lakers vs Celtics" })).toBe(true);
  });

  it("rejects cripto — the matrix showed its <1h cell was too weak (+0.5%)", () => {
    expect(isEligible({ ...base, marketQuestion: "Bitcoin Up or Down - 3PM" })).toBe(false);
  });

  it("rejects a market scheduled past the fast window", () => {
    expect(isEligible({ ...base, expectedResolutionHours: FAST_RESOLVE_HOURS + 0.01 })).toBe(false);
  });

  it("accepts right at the boundary", () => {
    expect(isEligible({ ...base, expectedResolutionHours: FAST_RESOLVE_HOURS })).toBe(true);
  });

  it("rejects when the scheduled end is unknown", () => {
    expect(isEligible({ ...base, expectedResolutionHours: null })).toBe(false);
  });

  it("rejects a scheduled end already in the past — stale metadata, not a fast market", () => {
    expect(isEligible({ ...base, expectedResolutionHours: -0.1 })).toBe(false);
    expect(isEligible({ ...base, expectedResolutionHours: 0 })).toBe(false);
  });

  it("rejects La Crema, whose copies mirror the other arms", () => {
    expect(isEligible({ ...base, track: "elite" })).toBe(false);
  });
});
