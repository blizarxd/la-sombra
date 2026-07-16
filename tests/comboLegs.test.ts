import { describe, expect, it } from "vitest";
import {
  decideComboByLegs,
  isAffirmativeLeg,
  judgeAffirmativeLeg,
  REDEEM_GRACE_MS,
  splitComboLegs,
  type LegState,
} from "@/lib/comboLegs";

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

describe("decideComboByLegs", () => {
  const NOW = 1_800_000_000_000;
  const settledLongAgo = (q: string): LegState => ({
    question: q,
    resolved: true,
    endDateMs: NOW - 48 * 3600_000,
    outcome: "unknown",
  });

  it("a readable leg resolved AGAINST the pick kills the parlay immediately", () => {
    const legs: LegState[] = [
      { question: "Will Spain win on 2026-07-14?", resolved: true, endDateMs: NOW - 3600_000, outcome: "lost" },
      { question: "Games Total: O/U 2.5", resolved: false, endDateMs: null, outcome: "unknown" },
    ];
    // Note: it does NOT wait for the other leg — one miss is already fatal.
    expect(decideComboByLegs(legs, NOW)).toEqual({ kind: "lost_leg", leg: "Will Spain win on 2026-07-14?" });
  });

  it("all legs settled and never claimed past the grace = LOST", () => {
    const v = decideComboByLegs([settledLongAgo("A vs B"), settledLongAgo("C vs D")], NOW);
    expect(v.kind).toBe("lost_unclaimed");
    if (v.kind === "lost_unclaimed") expect(v.hoursSinceResolved).toBeCloseTo(48, 0);
  });

  /**
   * The measured gap this rule rides on (2026-07-16): winners claimed
   * +2.4h..+3.6h after the last leg; losers never claimed at all. Inside the
   * grace we must NOT call it — the winner may simply not have claimed yet.
   */
  it("does NOT call a loss while still inside the measured claim window", () => {
    const legs: LegState[] = [
      { question: "A vs B", resolved: true, endDateMs: NOW - 4 * 3600_000, outcome: "unknown" },
    ];
    expect(decideComboByLegs(legs, NOW)).toEqual({ kind: "hold", allLegsResolved: true });
  });

  it("waits when ANY leg is still open — a far-future leg must never be killed early", () => {
    const legs: LegState[] = [
      settledLongAgo("A vs B"),
      { question: "Will France win on 2026-07-30?", resolved: false, endDateMs: null, outcome: "unknown" },
    ];
    expect(decideComboByLegs(legs, NOW)).toEqual({ kind: "hold", allLegsResolved: false });
  });

  it("a leg we could not look up at all blocks the verdict — never guess", () => {
    const legs: LegState[] = [settledLongAgo("A vs B"), { question: "???", resolved: null, endDateMs: null, outcome: "unknown" }];
    expect(decideComboByLegs(legs, NOW)).toEqual({ kind: "hold", allLegsResolved: false });
  });

  it("resolved but undatable legs hold — no end date means no grace to measure", () => {
    const legs: LegState[] = [{ question: "A vs B", resolved: true, endDateMs: null, outcome: "unknown" }];
    expect(decideComboByLegs(legs, NOW)).toEqual({ kind: "hold", allLegsResolved: true });
  });

  it("uses the LAST leg's end date, not the first", () => {
    const legs: LegState[] = [
      { question: "A vs B", resolved: true, endDateMs: NOW - 200 * 3600_000, outcome: "unknown" },
      { question: "C vs D", resolved: true, endDateMs: NOW - 2 * 3600_000, outcome: "unknown" }, // still fresh
    ];
    expect(decideComboByLegs(legs, NOW)).toEqual({ kind: "hold", allLegsResolved: true });
  });

  it("the grace is the measured 12h — 3.3x the slowest observed claim", () => {
    expect(REDEEM_GRACE_MS).toBe(12 * 3600_000);
    const legs = [{ question: "A vs B", resolved: true, endDateMs: NOW - REDEEM_GRACE_MS - 1000, outcome: "unknown" as const }];
    expect(decideComboByLegs(legs, NOW).kind).toBe("lost_unclaimed");
  });

  it("an empty leg list is never a verdict", () => {
    expect(decideComboByLegs([], NOW)).toEqual({ kind: "hold", allLegsResolved: false });
  });
});
