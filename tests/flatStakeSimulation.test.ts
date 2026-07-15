import { describe, expect, it } from "vitest";
import { paperTrades } from "@/db/schema";
import { getFlatStakeSimulation } from "@/lib/queries";
import { newId } from "@/lib/ids";
import { testDb } from "./helpers/db";

type Seed = {
  track: "core" | "live" | "trade" | "crypto" | "elite" | "combo";
  simulatedPositionSize: number;
  realizedPnl: number;
  status?: "resolved" | "closed" | "open";
};

function seed(db: ReturnType<typeof testDb>, s: Seed) {
  db.insert(paperTrades)
    .values({
      id: newId(),
      decisionJournalId: newId(),
      walletAddress: "0xabc",
      marketId: newId(),
      marketQuestion: "Yankees vs. Red Sox",
      side: "BUY",
      entryPrice: 0.5,
      simulatedPositionSize: s.simulatedPositionSize,
      shares: 10,
      realizedPnl: s.status === "open" ? null : s.realizedPnl,
      unrealizedPnl: s.status === "open" ? s.realizedPnl : null,
      status: s.status ?? "resolved",
      track: s.track,
      openedAt: new Date("2026-07-10T12:00:00Z"),
      resolvedAt: s.status === "open" ? null : new Date("2026-07-13T12:00:00Z"),
    })
    .run();
}

describe("getFlatStakeSimulation", () => {
  it("rescales PnL linearly to the flat stake, per trade", () => {
    const db = testDb();
    // $20 stake, +$10 pnl (50% return) -> at $5 flat, same 50% return = +$2.50
    seed(db, { track: "core", simulatedPositionSize: 20, realizedPnl: 10 });
    // $5 stake, -$2 pnl (-40% return) -> already flat, unchanged
    seed(db, { track: "core", simulatedPositionSize: 5, realizedPnl: -2 });

    const [core] = getFlatStakeSimulation(db, 5).filter((r) => r.track === "core");
    expect(core.actualPnl).toBe(8); // 10 - 2
    expect(core.actualStaked).toBe(25); // 20 + 5
    expect(core.flatPnl).toBeCloseTo(0.5); // 2.5 - 2
    expect(core.flatStaked).toBe(10); // 2 trades * $5
    expect(core.variesStake).toBe(true);
  });

  it("leaves already-flat books unchanged — real and simulated should match (sanity control)", () => {
    const db = testDb();
    seed(db, { track: "trade", simulatedPositionSize: 5, realizedPnl: 3 });
    seed(db, { track: "trade", simulatedPositionSize: 5, realizedPnl: -1 });

    const [trade] = getFlatStakeSimulation(db, 5).filter((r) => r.track === "trade");
    expect(trade.actualPnl).toBe(trade.flatPnl);
    expect(trade.actualRoi).toBeCloseTo(trade.flatRoi!);
    expect(trade.variesStake).toBe(false);
  });

  it("excludes open positions and zero/invalid stakes", () => {
    const db = testDb();
    seed(db, { track: "core", simulatedPositionSize: 999, realizedPnl: 999, status: "open" });
    seed(db, { track: "core", simulatedPositionSize: 10, realizedPnl: 5 });

    const [core] = getFlatStakeSimulation(db, 5).filter((r) => r.track === "core");
    expect(core.count).toBe(1);
    expect(core.actualPnl).toBe(5);
  });

  it("a big confidence-scaled win should show up as REAL ROI beating flat ROI when sizing is smart", () => {
    const db = testDb();
    // High-confidence trades ($20) win big; low-confidence trades ($5) mostly break even.
    // This is the shape that would prove confidence-sizing is adding value.
    seed(db, { track: "core", simulatedPositionSize: 20, realizedPnl: 16 }); // 80% return, big stake
    seed(db, { track: "core", simulatedPositionSize: 5, realizedPnl: -1 }); // -20% return, small stake

    const [core] = getFlatStakeSimulation(db, 5).filter((r) => r.track === "core");
    expect(core.actualRoi!).toBeGreaterThan(core.flatRoi!);
  });
});
