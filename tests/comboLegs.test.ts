import { describe, expect, it } from "vitest";
import { isAffirmativeLeg, judgeAffirmativeLeg, splitComboLegs } from "@/lib/comboLegs";

// Real combo titles observed live 2026-07-16 on Combo Cup wallets.
const REAL_TITLE =
  "England vs. Argentina: O/U 2.5 AND France vs. Spain: O/U 2.5 AND Will Argentina win on 2026-07-15? AND Will Spain win on 2026-07-14?";

describe("splitComboLegs", () => {
  it("splits a real 4-leg title on ' AND '", () => {
    expect(splitComboLegs(REAL_TITLE)).toEqual([
      "England vs. Argentina: O/U 2.5",
      "France vs. Spain: O/U 2.5",
      "Will Argentina win on 2026-07-15?",
      "Will Spain win on 2026-07-14?",
    ]);
  });

  it("does not split on a lowercase 'and' inside a team name", () => {
    expect(splitComboLegs("Will Trinidad and Tobago win on 2026-07-01? AND Will Spain win on 2026-07-02?")).toEqual([
      "Will Trinidad and Tobago win on 2026-07-01?",
      "Will Spain win on 2026-07-02?",
    ]);
  });

  it("handles null/empty titles without crashing", () => {
    expect(splitComboLegs(null)).toEqual([]);
    expect(splitComboLegs("")).toEqual([]);
  });
});

describe("isAffirmativeLeg", () => {
  it("accepts 'Will …?' legs — their Yes side is readable from the text", () => {
    expect(isAffirmativeLeg("Will Argentina win on 2026-07-15?")).toBe(true);
  });

  it("rejects O/U and spread legs — the bettor's side is NOT in the title", () => {
    expect(isAffirmativeLeg("England vs. Argentina: O/U 2.5")).toBe(false);
    expect(isAffirmativeLeg("Spread: Spain (-1.5)")).toBe(false);
  });
});

describe("judgeAffirmativeLeg", () => {
  const resolvedYes = {
    closed: true,
    umaResolutionStatus: "resolved",
    outcomes: '["Yes", "No"]',
    outcomePrices: '["1", "0"]',
  };

  it("a Yes-resolved leg WON (real gamma shape from Will Argentina win on 2026-07-15?)", () => {
    expect(judgeAffirmativeLeg(resolvedYes)).toBe("won");
  });

  it("a No-resolved leg LOST — this is the signal that kills the parlay", () => {
    expect(judgeAffirmativeLeg({ ...resolvedYes, outcomePrices: '["0", "1"]' })).toBe("lost");
  });

  it("an open market is NOT a verdict, even at an extreme price", () => {
    expect(judgeAffirmativeLeg({ ...resolvedYes, closed: false, umaResolutionStatus: null, outcomePrices: '["0.01", "0.99"]' })).toBe("open");
  });

  it("closed but not uma-resolved stays open — early closes must not be judged", () => {
    expect(judgeAffirmativeLeg({ ...resolvedYes, umaResolutionStatus: "proposed" })).toBe("open");
  });

  it("a partial resolution price (not exactly 0 or 1) is unknown — never guess", () => {
    expect(judgeAffirmativeLeg({ ...resolvedYes, outcomePrices: '["0.5", "0.5"]' })).toBe("unknown");
  });

  it("malformed JSON or missing Yes outcome is unknown, not a crash", () => {
    expect(judgeAffirmativeLeg({ ...resolvedYes, outcomePrices: "not json" })).toBe("unknown");
    expect(judgeAffirmativeLeg({ ...resolvedYes, outcomes: '["Over", "Under"]' })).toBe("unknown");
  });
});
