import { describe, expect, it } from "vitest";
import { projectOpenByWindow } from "@/lib/projection";

describe("projectOpenByWindow (parked-capital / Little's Law)", () => {
  // Hold times (days) of settled copies: a mix of fast and slow resolvers.
  const holds = [1, 2, 3, 4, 5, 10, 20, 30, 40, 45];

  it("shorter windows qualify fewer copies and project fewer open positions", () => {
    const r = projectOpenByWindow(holds, 10, [5, 30, 45]);
    const w5 = r.find((x) => x.windowDays === 5)!;
    const w30 = r.find((x) => x.windowDays === 30)!;
    const w45 = r.find((x) => x.windowDays === 45)!;

    // 5 of 10 holds are <=5 days -> 50% qualify; all 10 <=45 -> 100%.
    expect(w5.qualifyShare).toBe(0.5);
    expect(w45.qualifyShare).toBe(1);
    // Monotonic: tighter window => fewer projected open positions.
    expect(w5.projectedOpen).toBeLessThan(w30.projectedOpen);
    expect(w30.projectedOpen).toBeLessThanOrEqual(w45.projectedOpen);
  });

  it("applies Little's Law: open = arrival*share * avgHold", () => {
    // window 5: qualifying holds = [1,2,3,4,5], avg=3, share=0.5, arrival=10
    // copiesPerDay = 10*0.5 = 5 ; projectedOpen = 5 * 3 = 15
    const w5 = projectOpenByWindow(holds, 10, [5])[0];
    expect(w5.avgHoldDays).toBe(3);
    expect(w5.copiesPerDay).toBe(5);
    expect(w5.projectedOpen).toBe(15);
  });

  it("handles an empty history without dividing by zero", () => {
    const r = projectOpenByWindow([], 10, [5, 30]);
    expect(r.every((x) => x.qualifyShare === 0 && x.projectedOpen === 0)).toBe(true);
  });
});
