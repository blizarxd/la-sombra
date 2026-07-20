import { describe, expect, it } from "vitest";
import { paperTrades } from "@/db/schema";
import { newId } from "@/lib/ids";
import { getEliteBookStats } from "@/lib/queries";
import { testDb } from "./helpers/db";

/**
 * La Crema's ledger holds TWO different experiments: the failed top-10-wallet
 * design (gold_rule null) and the matrix-driven one (gold_rule stamped).
 * Judging the new design by the combined number is judging it by the old one's
 * hole — which is exactly what every AI cut was doing ("Elite failed").
 */
function seed(
  db: ReturnType<typeof testDb>,
  o: { pnl: number; goldRule?: string | null; status?: "open" | "resolved" },
) {
  const status = o.status ?? "resolved";
  db.insert(paperTrades)
    .values({
      id: newId(),
      decisionJournalId: newId(),
      walletAddress: "0xabc",
      marketId: newId(),
      marketQuestion: "LoL: G2 vs T1",
      side: "BUY",
      entryPrice: 0.45,
      simulatedPositionSize: 5,
      shares: 11,
      realizedPnl: status === "open" ? null : o.pnl,
      unrealizedPnl: status === "open" ? o.pnl : null,
      status,
      track: "elite",
      goldRule: o.goldRule ?? null,
      openedAt: new Date(),
      resolvedAt: status === "open" ? null : new Date(),
    })
    .run();
}

describe("getEliteBookStats — design generations", () => {
  it("splits the failed legacy from the matrix-driven design", () => {
    const db = testDb();
    seed(db, { pnl: -50 }); // legacy: no gold rule
    seed(db, { pnl: -30 }); // legacy
    seed(db, { pnl: 8, goldRule: "esports-barato" }); // new design
    const s = getEliteBookStats(db);
    expect(s.legacy.realizedPnl).toBe(-80);
    expect(s.matrixDriven.realizedPnl).toBe(8);
    // The combined number is still there, but it is NOT the new design's verdict.
    expect(s.realizedPnl).toBe(-72);
  });

  it("a green new design is not hidden by a red legacy", () => {
    const db = testDb();
    seed(db, { pnl: -100 });
    seed(db, { pnl: 5, goldRule: "esports-barato" });
    seed(db, { pnl: 5, goldRule: "banda-ventana" });
    const s = getEliteBookStats(db);
    expect(s.totalPnl).toBeLessThan(0); // book looks terrible
    expect(s.matrixDriven.totalPnl).toBe(10); // but the experiment is green
    expect(s.matrixDriven.winRate).toBe(1);
  });

  it("reports each gold rule on its own so the drainer can be cut, not the book", () => {
    const db = testDb();
    seed(db, { pnl: 12, goldRule: "esports-barato" });
    seed(db, { pnl: 4, goldRule: "esports-barato" });
    seed(db, { pnl: -9, goldRule: "banda-ventana" });
    const s = getEliteBookStats(db);
    // "esports-barato" is a pre-engine stamp; the board groups by its CANONICAL
    // cell id so old and new copies of the same cell share one row.
    expect(s.byRule.get("cat-band:esports:p00")?.realizedPnl).toBe(16);
    expect(s.byRule.get("banda-ventana")?.realizedPnl).toBe(-9);
    expect(s.byRule.get("cat-band:esports:p00")?.winRate).toBe(1);
  });

  it("sellos viejos y nuevos de la MISMA celda caen en la misma fila del tablero", () => {
    const db = testDb();
    seed(db, { pnl: 5, goldRule: "mañana" }); // pre-engine stamp
    seed(db, { pnl: 3, goldRule: "hour:08" }); // engine stamp
    const s = getEliteBookStats(db);
    expect(s.byRule.get("hour:08")?.realizedPnl).toBe(8);
    expect(s.byRule.has("mañana")).toBe(false);
  });

  it("counts open positions in the right generation without touching realized", () => {
    const db = testDb();
    seed(db, { pnl: 2, goldRule: "esports-barato", status: "open" });
    const s = getEliteBookStats(db);
    expect(s.matrixDriven.openCount).toBe(1);
    expect(s.matrixDriven.settledCount).toBe(0);
    expect(s.matrixDriven.realizedPnl).toBe(0);
    expect(s.matrixDriven.totalPnl).toBe(2);
  });

  it("an all-legacy book reports an empty new design instead of fake zeros", () => {
    const db = testDb();
    seed(db, { pnl: -20 });
    const s = getEliteBookStats(db);
    expect(s.matrixDriven.count).toBe(0);
    expect(s.matrixDriven.winRate).toBeNull();
    expect(s.byRule.size).toBe(0);
  });
});

describe("getRealizedPnlSeries — strategy-own curve", () => {
  it("starts the curve at the strategy's beginning instead of the retired design's hole", async () => {
    const { getRealizedPnlSeries } = await import("@/lib/queries");
    const db = testDb();
    const OLD = Date.now() - 10 * 24 * 3600 * 1000;
    const NEW = Date.now() - 3600_000;
    // Retired design: a big loss opened 10 days ago.
    db.insert(paperTrades)
      .values({
        id: newId(), decisionJournalId: newId(), walletAddress: "0xabc", marketId: newId(),
        marketQuestion: "old", side: "BUY", entryPrice: 0.5, simulatedPositionSize: 5, shares: 10,
        realizedPnl: -150, status: "resolved", track: "elite", openedAt: new Date(OLD),
        resolvedAt: new Date(OLD + 3600_000),
      })
      .run();
    // Hybrid: a small win opened an hour ago.
    db.insert(paperTrades)
      .values({
        id: newId(), decisionJournalId: newId(), walletAddress: "0xabc", marketId: newId(),
        marketQuestion: "new", side: "BUY", entryPrice: 0.65, simulatedPositionSize: 5, shares: 7.7,
        realizedPnl: 3, status: "resolved", track: "elite", goldRule: "banda-ventana",
        openedAt: new Date(NEW), resolvedAt: new Date(NEW + 60_000),
      })
      .run();

    const all = getRealizedPnlSeries(db, "elite");
    const own = getRealizedPnlSeries(db, "elite", { openedSinceMs: Date.now() - 2 * 24 * 3600 * 1000 });
    // Unfiltered the strategy looks $147 underwater; its own curve starts at zero.
    expect(all[all.length - 1].pnl).toBeCloseTo(-147, 5);
    expect(own).toHaveLength(1);
    expect(own[0].pnl).toBeCloseTo(3, 5);
  });
});
