import { describe, expect, it } from "vitest";
import { chunk, mapWithConcurrency } from "@/lib/concurrency";

describe("mapWithConcurrency", () => {
  it("keeps results in INPUT order, not completion order", async () => {
    // Later items finish first — the output must not reorder because of it.
    const out = await mapWithConcurrency([30, 20, 10], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 20, 10]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 30 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it really is running in parallel
  });

  it("visits every item exactly once — no wallet silently skipped or double-fetched", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 7, async (i) => {
      seen.push(i);
      return i;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });

  it("propagates a rejection instead of swallowing it into a fake result", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("upstream down");
        return n;
      }),
    ).rejects.toThrow("upstream down");
  });

  it("treats a limit larger than the list as fine", async () => {
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });
});

describe("chunk", () => {
  it("splits into fixed-size groups with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("keeps every element — nothing dropped at the boundary", () => {
    const items = Array.from({ length: 97 }, (_, i) => i);
    expect(chunk(items, 10).flat()).toEqual(items);
  });
});
