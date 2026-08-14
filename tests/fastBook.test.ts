import { describe, expect, it } from "vitest";
import { isEligible } from "@/lib/fastBook";

describe("fastBook isEligible", () => {
  const base = { track: "core", marketQuestion: "LoL: Shifters vs SK Gaming - Game 2 Winner" };

  it("takes an esports sub-map/game market", () => {
    expect(isEligible(base)).toBe(true);
  });

  it("takes a deportes split-period market", () => {
    // "Draw at halftime?" alone has no team/league keyword, so categorizeMarket
    // files it under "otros", not "deportes" — the "vs." is what makes it sport.
    expect(isEligible({ ...base, marketQuestion: "AS Saint-Étienne vs. Clermont Foot 63: Draw at halftime?" })).toBe(
      true,
    );
  });

  it("rejects cripto — the matrix showed its <1h cell was too weak (+0.5%)", () => {
    expect(isEligible({ ...base, marketQuestion: "Bitcoin Up or Down - 3PM" })).toBe(false);
  });

  it("rejects an esports market that is NOT a fast sub-format (the full series)", () => {
    expect(
      isEligible({ ...base, marketQuestion: "Dota 2: Nigma Galaxy vs Vici Gaming (BO3) - The International" }),
    ).toBe(false);
  });

  it("rejects a deportes market that is a full-match outcome, not a split period", () => {
    expect(isEligible({ ...base, marketQuestion: "St. Louis Cardinals vs. Chicago Cubs" })).toBe(false);
  });

  it("rejects La Crema, whose copies mirror the other arms", () => {
    expect(isEligible({ ...base, track: "elite" })).toBe(false);
  });
});
