import { describe, expect, it } from "vitest";
import { bucketByTime, fmtAxisMoney, moneyTicks, niceStep } from "@/app/components/PnlChart";

const HOUR = 3600_000;

describe("bucketByTime", () => {
  /**
   * The bug this replaced: the old downsampler emitted the MIN and the MAX of
   * every bucket — a waveform technique that draws a zigzag between each
   * bucket's floor and ceiling. It turned ~900 emitted points across ~690px
   * into a hairball. One reading per bucket is the whole point.
   */
  it("never emits more points than asked for", () => {
    const pts = Array.from({ length: 5000 }, (_, i) => ({ t: i * 60_000, pnl: Math.sin(i) * 50 }));
    expect(bucketByTime(pts, 138).length).toBeLessThanOrEqual(138);
  });

  it("emits ONE point per bucket, not a min/max pair — no synthetic zigzag", () => {
    // Two readings inside every bucket, wildly apart. The old code emitted both.
    const pts = [
      { t: 0, pnl: -100 },
      { t: 1, pnl: 100 },
      { t: 1000, pnl: -100 },
      { t: 1001, pnl: 100 },
    ];
    const out = bucketByTime(pts, 2);
    expect(out).toHaveLength(2);
  });

  it("keeps the LAST reading in a bucket — a real observation, never an average", () => {
    const pts = [
      { t: 0, pnl: 10 },
      { t: 1, pnl: 20 },
      { t: 2, pnl: 30 }, // the close of bucket 0
      { t: 1000, pnl: 99 },
    ];
    const out = bucketByTime(pts, 2);
    expect(out.map((p) => p.pnl)).toEqual([30, 99]);
    // Every emitted value exists in the input — nothing invented.
    for (const p of out) expect(pts.some((q) => q.pnl === p.pnl && q.t === p.t)).toBe(true);
  });

  it("always ends on the most recent reading — the current value must never be dropped", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i * HOUR, pnl: i }));
    const out = bucketByTime(pts, 50);
    expect(out[out.length - 1]).toEqual({ t: 999 * HOUR, pnl: 999 });
  });

  it("returns points untouched when they already fit", () => {
    const pts = [
      { t: 0, pnl: 1 },
      { t: HOUR, pnl: 2 },
    ];
    expect(bucketByTime(pts, 100)).toEqual(pts);
  });

  it("buckets by TIME, so unevenly-spaced readings keep an honest x axis", () => {
    // A burst of readings in one minute, then a lone one a day later. Index-based
    // bucketing would give the burst most of the width; time-based must not.
    const burst = Array.from({ length: 60 }, (_, i) => ({ t: i * 1000, pnl: i }));
    const later = { t: 24 * HOUR, pnl: 999 };
    const out = bucketByTime([...burst, later], 10);
    // The whole burst collapses into the first bucket(s); the lone late reading survives.
    expect(out[out.length - 1]).toEqual(later);
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it("sorts by time — an out-of-order input must not produce a line that doubles back", () => {
    const pts = [
      { t: 3000, pnl: 3 },
      { t: 1000, pnl: 1 },
      { t: 2000, pnl: 2 },
      { t: 0, pnl: 0 },
    ];
    const out = bucketByTime(pts, 2);
    const times = out.map((p) => p.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("survives all-identical timestamps without dividing by zero", () => {
    const pts = Array.from({ length: 10 }, () => ({ t: 5, pnl: 1 }));
    expect(() => bucketByTime(pts, 3)).not.toThrow();
  });
});

describe("moneyTicks", () => {
  it("always puts a line on zero, so the polarity split has a rule to sit on", () => {
    expect(moneyTicks(-114, 60)).toContain(0);
    expect(moneyTicks(0, 250)).toContain(0);
  });

  it("uses ONE step on both sides of zero — ticks stay evenly spaced across it", () => {
    const ticks = moneyTicks(-100, 100);
    const gaps = ticks.slice(1).map((v, i) => v - ticks[i]);
    expect(new Set(gaps).size).toBe(1);
  });

  it("spans the data without overshooting it — gridlines stay inside the plot", () => {
    // -114..60 at 3 ticks/side -> step 50 -> [-100,-50,0,50]. The top reading
    // sits above the last gridline, which is correct: a rule past the data
    // would just pad the axis with empty space.
    const ticks = moneyTicks(-114, 60);
    expect(ticks).toEqual([-100, -50, 0, 50]);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(-114);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(60);
  });

  it("gives an all-positive book a zero floor and no negative rules", () => {
    const ticks = moneyTicks(0, 250);
    expect(Math.min(...ticks)).toBe(0);
    expect(ticks.every((t) => t >= 0)).toBe(true);
  });
});

describe("niceStep", () => {
  it("rounds to 1-2-5 magnitudes", () => {
    expect(niceStep(0.9)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(37)).toBe(50);
    expect(niceStep(120)).toBe(200);
  });

  it("never returns zero or negative — it divides the axis", () => {
    expect(niceStep(0)).toBeGreaterThan(0);
    expect(niceStep(-5)).toBeGreaterThan(0);
  });
});

describe("fmtAxisMoney", () => {
  it("puts the sign before the currency symbol", () => {
    expect(fmtAxisMoney(-114)).toBe("-$114");
    expect(fmtAxisMoney(60)).toBe("$60");
    expect(fmtAxisMoney(0)).toBe("$0");
  });
});
