import { describe, expect, it } from "vitest";
import { paperTrades } from "@/db/schema";
import { getDailyPnlByBook } from "@/lib/queries";
import { newId } from "@/lib/ids";
import { testDb } from "./helpers/db";

type Seed = {
  track: "core" | "live" | "trade" | "crypto";
  realizedPnl: number;
  status?: "resolved" | "closed" | "open";
  resolvedAt?: Date;
  closedAt?: Date;
};

function seed(db: ReturnType<typeof testDb>, s: Seed) {
  db.insert(paperTrades)
    .values({
      id: newId(),
      decisionJournalId: newId(),
      walletAddress: "0xabc",
      marketId: "0xmkt",
      side: "BUY",
      entryPrice: 0.5,
      simulatedPositionSize: 5,
      shares: 10,
      realizedPnl: s.realizedPnl,
      status: s.status ?? "resolved",
      track: s.track,
      openedAt: new Date("2026-07-10T12:00:00Z"),
      resolvedAt: s.resolvedAt ?? null,
      closedAt: s.closedAt ?? null,
    })
    .run();
}

// 16:00Z == 12:00 in UTC-4 (America/Caracas), so the day key is unambiguous.
const D13 = new Date("2026-07-13T16:00:00Z");
const D12 = new Date("2026-07-12T16:00:00Z");

describe("getDailyPnlByBook", () => {
  it("buckets realized PnL by settle day and book, newest first", () => {
    const db = testDb();
    seed(db, { track: "core", realizedPnl: 10, resolvedAt: D13 });
    seed(db, { track: "core", realizedPnl: -3, resolvedAt: D13 });
    seed(db, { track: "live", realizedPnl: 4, resolvedAt: D13 });
    seed(db, { track: "core", realizedPnl: 5, resolvedAt: D12 });

    const r = getDailyPnlByBook(db);
    expect(r.days.map((d) => d.day)).toEqual(["2026-07-13", "2026-07-12"]); // newest first

    const d13 = r.days[0];
    expect(d13.byTrack.core).toEqual({ pnl: 7, count: 2 }); // 10 + (-3)
    expect(d13.byTrack.live).toEqual({ pnl: 4, count: 1 });
    expect(d13.byTrack.trade).toEqual({ pnl: 0, count: 0 }); // always present, even empty
    expect(d13.total).toBe(11);
    expect(d13.totalCount).toBe(3);
  });

  it("counts exit-closed trades by their closedAt when resolvedAt is absent", () => {
    const db = testDb();
    seed(db, { track: "trade", realizedPnl: 2, status: "closed", closedAt: D13 });
    const r = getDailyPnlByBook(db);
    expect(r.days[0].byTrack.trade).toEqual({ pnl: 2, count: 1 });
  });

  it("ignores open positions and totals per book across days", () => {
    const db = testDb();
    seed(db, { track: "core", realizedPnl: 99, status: "open" }); // no settle -> excluded
    seed(db, { track: "core", realizedPnl: 6, resolvedAt: D13 });
    seed(db, { track: "core", realizedPnl: 4, resolvedAt: D12 });

    const r = getDailyPnlByBook(db);
    expect(r.totals.core).toEqual({ pnl: 10, count: 2 });
    expect(r.grandTotal).toBe(10);
    expect(r.grandCount).toBe(2);
  });
});
