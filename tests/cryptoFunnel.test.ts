import { describe, expect, it } from "vitest";
import { observedTrades, walletProfiles } from "@/db/schema";
import { getCryptoFunnel } from "@/lib/queries";
import { testDb } from "./helpers/db";

/**
 * The funnel exists to answer ONE question with real data: at which stage does
 * the crypto book's pipeline die (3 AI cuts in a row reported 0/0)? These tests
 * pin each stage's definition so the diagnostic itself can be trusted.
 */

let n = 0;
function addWallet(
  db: ReturnType<typeof testDb>,
  w: {
    sources?: string | null;
    status?: "track" | "watch" | "ignore";
    lastScannedAt?: Date | null;
    globalScore?: number | null;
    tradingStyle?: string | null;
  },
): string {
  const now = new Date();
  const address = `0x${String(++n).padStart(40, "0")}`;
  db.insert(walletProfiles)
    .values({
      id: `w${n}`,
      address,
      sourceRank: 9000 + n,
      status: w.status ?? "watch",
      sources: w.sources === undefined ? "crypto-market" : w.sources,
      lastScannedAt: w.lastScannedAt === undefined ? now : w.lastScannedAt,
      globalScore: w.globalScore ?? null,
      tradingStyle: w.tradingStyle ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return address;
}

function addSignal(db: ReturnType<typeof testDb>, walletAddress: string, side: "BUY" | "SELL", price: number, ageMs = 0) {
  const ts = new Date(Date.now() - ageMs);
  db.insert(observedTrades)
    .values({
      id: `obs${++n}`,
      walletAddress,
      marketId: "m1",
      side,
      walletEntryPrice: price,
      detectedPrice: price,
      size: 10,
      timestamp: ts,
      dedupeKey: `dk${n}`,
      scored: false,
      rawTradeJson: "{}",
      createdAt: ts,
    })
    .run();
}

describe("getCryptoFunnel", () => {
  it("counts only crypto-market wallets — other sources are not this book's problem", () => {
    const db = testDb();
    addWallet(db, {});
    addWallet(db, { sources: "fast-market" });
    addWallet(db, { sources: null });
    expect(getCryptoFunnel(db).minedCount).toBe(1);
  });

  it("separates mined-but-never-profiled from profiled", () => {
    const db = testDb();
    addWallet(db, { lastScannedAt: null });
    addWallet(db, {});
    const f = getCryptoFunnel(db);
    expect(f.minedCount).toBe(2);
    expect(f.profiledCount).toBe(1);
  });

  it("flags the suspected gap: eligible for the book but NOT tracked = invisible to the monitor", () => {
    const db = testDb();
    // High holder score but stuck in watch: the book would take its trades,
    // the monitor never observes it. This is the outage mode being hunted.
    addWallet(db, { status: "watch", globalScore: 90 });
    const f = getCryptoFunnel(db);
    expect(f.eligibleCount).toBe(1);
    expect(f.trackedCount).toBe(0);
    expect(f.eligibleNotTrackedCount).toBe(1);
  });

  it("a tracked, eligible wallet is NOT part of the gap", () => {
    const db = testDb();
    addWallet(db, { status: "track", globalScore: 90 });
    const f = getCryptoFunnel(db);
    expect(f.eligibleNotTrackedCount).toBe(0);
    expect(f.trackedCount).toBe(1);
  });

  it("signal side: only BUYs inside the entry band survive the last stage", () => {
    const db = testDb();
    const addr = addWallet(db, { status: "track", globalScore: 90 });
    const f0 = getCryptoFunnel(db);
    addSignal(db, addr, "BUY", (f0.band.min + f0.band.max) / 2); // in band
    addSignal(db, addr, "BUY", f0.band.max + 0.1); // too expensive
    addSignal(db, addr, "SELL", (f0.band.min + f0.band.max) / 2); // not a BUY
    const f = getCryptoFunnel(db);
    expect(f.signals7d).toBe(3);
    expect(f.buys7d).toBe(2);
    expect(f.buysInBand7d).toBe(1);
  });

  it("ignores signals older than 7 days — the funnel measures NOW, not history", () => {
    const db = testDb();
    const addr = addWallet(db, { status: "track", globalScore: 90 });
    addSignal(db, addr, "BUY", 0.6, 8 * 24 * 3600 * 1000);
    expect(getCryptoFunnel(db).signals7d).toBe(0);
  });

  it("an empty database yields an all-zero funnel, not a crash", () => {
    const f = getCryptoFunnel(testDb());
    expect(f.minedCount).toBe(0);
    expect(f.signals7d).toBe(0);
  });
});
