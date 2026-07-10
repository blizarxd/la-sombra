import { describe, expect, it } from "vitest";
import { computeBenchmarks, hypotheticalPnl, type DecisionOutcomeRow } from "@/lib/benchmarks";

const row = (
  decision: DecisionOutcomeRow["decision"],
  paperPnl: number | null,
  hypo: number | null,
  resolved = true,
): DecisionOutcomeRow => ({ decision, paperPnl, hypotheticalPnl: hypo, resolved });

describe("hypotheticalPnl", () => {
  it("computes $10-normalized pnl for a win at 50c", () => {
    expect(hypotheticalPnl(0.5, 1)).toBeCloseTo(10, 2); // 20 shares * $1 - $10
  });
  it("loses the stake on a loss", () => {
    expect(hypotheticalPnl(0.5, 0)).toBeCloseTo(-10, 2);
  });
  it("rejects impossible entries", () => {
    expect(hypotheticalPnl(0, 1)).toBeNull();
    expect(hypotheticalPnl(1, 1)).toBeNull();
  });
});

describe("computeBenchmarks", () => {
  const rows: DecisionOutcomeRow[] = [
    row("paper_copy", 8, 9),
    row("paper_copy", -5, -6),
    row("paper_copy", 4, 5),
    row("watchlist", null, 12), // missed winner
    row("watchlist", null, -10),
    row("skip", null, -10), // avoided loser / good skip
    row("skip", null, -10), // avoided loser
    row("skip", null, 15), // missed winner
    row("skip", null, null, false), // unresolved
  ];
  const b = computeBenchmarks(rows);

  it("separates the four strategy groups", () => {
    expect(b.botFiltered.count).toBe(3);
    expect(b.botFiltered.totalPnl).toBeCloseTo(7, 2);
    expect(b.botFiltered.winRate).toBeCloseTo(2 / 3, 4);
    expect(b.blindCopy.resolvedCount).toBe(8);
    expect(b.watchlistOnly.count).toBe(2);
    expect(b.skippedOnly.count).toBe(4);
  });

  it("counts missed winners, avoided losers, bad copies and good skips", () => {
    expect(b.missedWinners).toBe(2); // watchlist +12 and skip +15
    expect(b.avoidedLosers).toBe(2);
    expect(b.goodSkips).toBe(2);
    expect(b.badCopies).toBe(1);
  });

  it("declares whether the bot beats blind copying by avg pnl", () => {
    // bot avg = 7/3 = 2.33; blind avg = (9-6+5+12-10-10-10+15)/8 = 0.625
    expect(b.botBeatsBlind).toBe(true);
  });

  it("returns null verdict without resolved data", () => {
    const empty = computeBenchmarks([row("paper_copy", null, null, false)]);
    expect(empty.botBeatsBlind).toBeNull();
  });
});
