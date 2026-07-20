import { describe, expect, it } from "vitest";
import { paperTrades } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getSliceMatrices } from "@/lib/queries";
import { testDb } from "./helpers/db";

/**
 * The /matriz period filter (1d/7d/15d/30d/all): the all-time aggregate hides
 * how a cell did YESTERDAY — a vein that dried up days ago still looks green in
 * the total. These pin the filter's semantics: it cuts on openedAt, the same
 * axis the matrices bucket by.
 */

function seed(db: ReturnType<typeof testDb>, openedAt: Date, pnl: number) {
  db.insert(paperTrades)
    .values({
      id: newId(),
      decisionJournalId: newId(),
      walletAddress: "0xabc",
      marketId: newId(),
      marketQuestion: "Yankees vs. Red Sox",
      side: "BUY",
      entryPrice: 0.65,
      simulatedPositionSize: 5,
      shares: 7.7,
      realizedPnl: pnl,
      status: "resolved",
      track: "core",
      openedAt,
      resolvedAt: new Date(openedAt.getTime() + 3600_000),
    })
    .run();
}

const NOW = Date.now();
const HOURS = 3600_000;

describe("getSliceMatrices period filter", () => {
  it("without a filter, counts everything (the existing behaviour)", () => {
    const db = testDb();
    seed(db, new Date(NOW - 2 * HOURS), 3);
    seed(db, new Date(NOW - 100 * HOURS), -5);
    expect(getSliceMatrices(db)[0].sampleSize).toBe(2);
  });

  it("sinceMs keeps only trades OPENED inside the window", () => {
    const db = testDb();
    seed(db, new Date(NOW - 2 * HOURS), 3); // yesterday-ish
    seed(db, new Date(NOW - 100 * HOURS), -5); // 4 days ago
    const m = getSliceMatrices(db, { sinceMs: NOW - 24 * HOURS });
    expect(m[0].sampleSize).toBe(1);
  });

  it("a dried-up vein disappears from a short window but stays in the total", () => {
    const db = testDb();
    // Old wins, recent losses on the same cell.
    seed(db, new Date(NOW - 200 * HOURS), 4);
    seed(db, new Date(NOW - 201 * HOURS), 4);
    seed(db, new Date(NOW - 3 * HOURS), -5);
    const all = getSliceMatrices(db);
    const day = getSliceMatrices(db, { sinceMs: NOW - 24 * HOURS });
    const totalPnl = (m: ReturnType<typeof getSliceMatrices>[0]) =>
      m.rows.reduce((a, r) => a + r.totalPnl, 0);
    expect(totalPnl(all[0])).toBeCloseTo(3, 5); // +4+4-5 — still green overall
    expect(totalPnl(day[0])).toBeCloseTo(-5, 5); // but yesterday it BLED
  });

  it("still excludes open positions inside the window — settled only, as ever", () => {
    const db = testDb();
    db.insert(paperTrades)
      .values({
        id: newId(),
        decisionJournalId: newId(),
        walletAddress: "0xabc",
        marketId: newId(),
        marketQuestion: "Yankees vs. Red Sox",
        side: "BUY",
        entryPrice: 0.65,
        simulatedPositionSize: 5,
        shares: 7.7,
        unrealizedPnl: 1,
        status: "open",
        track: "core",
        openedAt: new Date(NOW - 1 * HOURS),
      })
      .run();
    expect(getSliceMatrices(db, { sinceMs: NOW - 24 * HOURS })[0].sampleSize).toBe(0);
  });
});
