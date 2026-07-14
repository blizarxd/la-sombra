import { describe, expect, it } from "vitest";
import {
  buildMatrix,
  DIMS,
  hourBlockKey,
  priceBandKey,
  summarizeMatrices,
  weekdayKey,
  type SettledTrade,
} from "@/lib/slices";

/** UTC-4: 12:00Z is 08:00 in Caracas. */
const at = (iso: string) => new Date(iso);

function t(over: Partial<SettledTrade> = {}): SettledTrade {
  return {
    track: "core",
    entryPrice: 0.5,
    simulatedPositionSize: 10,
    realizedPnl: 0,
    openedAt: at("2026-07-13T12:00:00Z"),
    marketQuestion: "Yankees vs. Red Sox",
    ...over,
  };
}

describe("dimension keys", () => {
  it("buckets hours into 4h blocks in the project timezone (UTC-4)", () => {
    expect(hourBlockKey(at("2026-07-13T12:00:00Z"))).toBe("08"); // 08:00 Caracas
    expect(hourBlockKey(at("2026-07-13T03:30:00Z"))).toBe("20"); // 23:30 the day BEFORE
    expect(hourBlockKey(at("2026-07-13T04:00:00Z"))).toBe("00"); // 00:00 Caracas
  });

  it("uses the project timezone for weekday, not UTC", () => {
    // Sunday 02:00 UTC is still SATURDAY (22:00) in Caracas.
    expect(weekdayKey(at("2026-07-12T02:00:00Z"))).toBe("6"); // Saturday
    expect(weekdayKey(at("2026-07-12T12:00:00Z"))).toBe("0"); // Sunday
  });

  it("maps entry prices to bands, rejecting impossible prices", () => {
    expect(priceBandKey(0.29)).toBe("p00");
    expect(priceBandKey(0.6)).toBe("p60");
    expect(priceBandKey(0.74)).toBe("p60");
    expect(priceBandKey(0.75)).toBe("p75");
    expect(priceBandKey(0.95)).toBe("p90");
    expect(priceBandKey(0)).toBeNull();
    expect(priceBandKey(1.4)).toBeNull();
  });
});

describe("buildMatrix", () => {
  const spec = {
    id: "x",
    title: "t",
    hint: "h",
    minSample: 3,
    rowDim: DIMS.priceBand,
    colDim: DIMS.track,
  };

  it("aggregates PnL, ROI, count and win rate per cell", () => {
    const m = buildMatrix(
      [
        t({ entryPrice: 0.65, realizedPnl: 6, simulatedPositionSize: 10 }),
        t({ entryPrice: 0.7, realizedPnl: -2, simulatedPositionSize: 10 }),
      ],
      spec,
    );
    const cell = m.rows.find((r) => r.key === "p60")!.cells.core!;
    expect(cell.pnl).toBe(4);
    expect(cell.count).toBe(2);
    expect(cell.winRate).toBe(0.5);
    expect(cell.roi).toBeCloseTo(4 / 20); // 20 USD staked
  });

  it("crowns by ROI, not raw PnL — a big book betting big is not automatically better", () => {
    const m = buildMatrix(
      [
        // p60: $30 profit on $300 staked = 10% ROI
        ...Array.from({ length: 3 }, () => t({ entryPrice: 0.65, realizedPnl: 10, simulatedPositionSize: 100 })),
        // p45: $9 profit on $30 staked = 30% ROI  <- better trade, smaller size
        ...Array.from({ length: 3 }, () => t({ entryPrice: 0.5, realizedPnl: 3, simulatedPositionSize: 10 })),
      ],
      spec,
    );
    expect(m.bestPerCol.core).toBe("p45");
    expect(m.worstPerCol.core).toBe("p60");
  });

  it("never crowns a cell below minSample — no 1-trade flukes", () => {
    const m = buildMatrix(
      [
        // A single spectacular trade in p90 — must NOT win the crown.
        t({ entryPrice: 0.95, realizedPnl: 500, simulatedPositionSize: 10 }),
        ...Array.from({ length: 3 }, () => t({ entryPrice: 0.65, realizedPnl: 1, simulatedPositionSize: 10 })),
        ...Array.from({ length: 3 }, () => t({ entryPrice: 0.5, realizedPnl: -1, simulatedPositionSize: 10 })),
      ],
      spec,
    );
    expect(m.bestPerCol.core).toBe("p60");
    expect(m.worstPerCol.core).toBe("p45");
  });

  it("declines to crown anything when only one cell clears minSample", () => {
    // Best-of-one is not a finding, it's the only option.
    const m = buildMatrix(
      Array.from({ length: 5 }, () => t({ entryPrice: 0.65, realizedPnl: 2 })),
      spec,
    );
    expect(m.bestPerCol.core).toBeNull();
    expect(m.worstPerCol.core).toBeNull();
  });

  it("keeps the books separate — a live pattern never leaks into core", () => {
    const m = buildMatrix(
      [
        ...Array.from({ length: 3 }, () => t({ track: "live", entryPrice: 0.65, realizedPnl: 5 })),
        ...Array.from({ length: 3 }, () => t({ track: "core", entryPrice: 0.65, realizedPnl: -5 })),
      ],
      spec,
    );
    const row = m.rows.find((r) => r.key === "p60")!;
    expect(row.cells.live!.pnl).toBe(15);
    expect(row.cells.core!.pnl).toBe(-15);
    expect(row.totalPnl).toBe(0);
    expect(row.totalCount).toBe(6);
  });

  it("drops rows and books with no data at all", () => {
    const m = buildMatrix([t({ entryPrice: 0.65, realizedPnl: 1 })], spec);
    expect(m.rows.map((r) => r.key)).toEqual(["p60"]);
    expect(m.rows[0].cells.crypto).toBeNull();
    expect(m.sampleSize).toBe(1);
  });

  it("ignores tracks outside the matrix (combos have no entry band to speak of)", () => {
    const m = buildMatrix([t({ track: "combo", entryPrice: 0.65, realizedPnl: 99 })], spec);
    expect(m.rows).toEqual([]);
    expect(m.sampleSize).toBe(0);
  });
});

describe("category dimension", () => {
  const spec = {
    id: "cat",
    title: "t",
    hint: "h",
    minSample: 3,
    rowDim: DIMS.category,
    colDim: DIMS.track,
  };

  it("derives category from the market question, per book", () => {
    const m = buildMatrix(
      [
        ...Array.from({ length: 3 }, () => t({ track: "live", marketQuestion: "Dota 2: Team A vs Team B", realizedPnl: 5 })),
        ...Array.from({ length: 3 }, () => t({ track: "core", marketQuestion: "Real Madrid vs. Barcelona", realizedPnl: -2 })),
      ],
      spec,
    );
    const esports = m.rows.find((r) => r.key === "esports")!;
    const deportes = m.rows.find((r) => r.key === "deportes")!;
    expect(esports.cells.live!.pnl).toBe(15);
    expect(esports.cells.core).toBeNull();
    expect(deportes.cells.core!.pnl).toBe(-6);
  });

  it("files trades with no question under 'otros'", () => {
    const m = buildMatrix(
      Array.from({ length: 3 }, () => t({ marketQuestion: null, realizedPnl: 1 })),
      spec,
    );
    expect(m.rows.map((r) => r.key)).toEqual(["otros"]);
  });
});

describe("summarizeMatrices", () => {
  it("hands the AI only the cells that clear minSample", () => {
    const m = buildMatrix(
      [
        t({ entryPrice: 0.95, realizedPnl: 500 }), // n=1, thin
        ...Array.from({ length: 3 }, () => t({ entryPrice: 0.65, realizedPnl: 2 })),
      ],
      { id: "x", title: "t", hint: "h", minSample: 3, rowDim: DIMS.priceBand, colDim: DIMS.track },
    );
    const [s] = summarizeMatrices([m]);
    expect(s.cells).toHaveLength(1);
    expect(s.cells[0]).toContain("60–74¢");
    expect(s.cells.join()).not.toContain("casi hecho"); // the n=1 fluke never reaches the model
  });
});
