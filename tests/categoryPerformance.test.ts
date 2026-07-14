import { describe, expect, it } from "vitest";
import { paperTrades } from "@/db/schema";
import { getCategoryPerformance } from "@/lib/queries";
import { newId } from "@/lib/ids";
import { testDb } from "./helpers/db";

type Seed = {
  track: "core" | "live" | "trade" | "crypto" | "elite" | "combo";
  marketQuestion: string;
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
      marketQuestion: s.marketQuestion,
      side: "BUY",
      entryPrice: 0.5,
      simulatedPositionSize: 5,
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

describe("getCategoryPerformance", () => {
  it("groups realized PnL by derived category, per arm — the core case: esports doing well in live", () => {
    const db = testDb();
    // live: esports wins twice, sports loses once
    seed(db, { track: "live", marketQuestion: "Dota 2: Team A vs Team B (BO3)", realizedPnl: 20 });
    seed(db, { track: "live", marketQuestion: "LoL: Team C vs Team D (BO1)", realizedPnl: 15 });
    seed(db, { track: "live", marketQuestion: "Real Madrid vs. Barcelona", realizedPnl: -8 });
    // core: only sports, doing fine
    seed(db, { track: "core", marketQuestion: "Yankees vs. Red Sox", realizedPnl: 12 });

    const r = getCategoryPerformance(db);
    const esports = r.categories.find((c) => c.category === "esports")!;
    expect(esports.byArm.live).toEqual({ pnl: 35, count: 2, winRate: 1 });
    expect(esports.byArm.core).toBeNull(); // no core esports data

    const sports = r.categories.find((c) => c.category === "deportes")!;
    expect(sports.byArm.live).toEqual({ pnl: -8, count: 1, winRate: 0 });
    expect(sports.byArm.core).toEqual({ pnl: 12, count: 1, winRate: 1 });
  });

  it("excludes OPEN positions (only settled trades count)", () => {
    const db = testDb();
    seed(db, { track: "core", marketQuestion: "Yankees vs. Red Sox", realizedPnl: 999, status: "open" });
    const r = getCategoryPerformance(db);
    expect(r.categories).toEqual([]);
  });

  it("crowns the best category per arm only with >= 3 settled samples (no 1-trade flukes)", () => {
    const db = testDb();
    // live: esports has 1 huge win (should NOT be crowned — too few samples)
    seed(db, { track: "live", marketQuestion: "Dota 2: A vs B", realizedPnl: 100 });
    // live: sports has 3 modest but consistent wins (should be crowned)
    seed(db, { track: "live", marketQuestion: "Team X vs. Team Y", realizedPnl: 5 });
    seed(db, { track: "live", marketQuestion: "Team Z vs. Team W", realizedPnl: 4 });
    seed(db, { track: "live", marketQuestion: "Team M vs. Team N", realizedPnl: 3 });

    const r = getCategoryPerformance(db);
    expect(r.bestPerArm.live).toBe("deportes");
  });

  it("sorts categories by combined pnl across all arms, best first", () => {
    const db = testDb();
    seed(db, { track: "core", marketQuestion: "Will the Fed cut rates?", realizedPnl: 1 });
    seed(db, { track: "core", marketQuestion: "Lakers vs. Celtics", realizedPnl: 50 });
    const r = getCategoryPerformance(db);
    expect(r.categories[0].category).toBe("deportes");
  });

  it("never includes combo in the arm columns", () => {
    const db = testDb();
    seed(db, { track: "combo", marketQuestion: "Team A vs Team B AND Team C vs Team D", realizedPnl: 30 });
    const r = getCategoryPerformance(db);
    expect(r.tracks).not.toContain("combo");
    expect(r.categories).toEqual([]); // only combo data existed, so nothing to show
  });
});
