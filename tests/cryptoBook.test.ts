import { describe, expect, it } from "vitest";
import { isCryptoBookEligible } from "@/lib/profiler";
import { DEFAULT_CRYPTO_RULES, applyRuleChanges, getActiveRules } from "@/lib/rules";
import { ruleSets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers/db";

describe("isCryptoBookEligible (₿ Crypto book gate — holder score OR swing record)", () => {
  const holder = { globalScore: 60, tradingStyle: "holdea", swingPnl30d: null, swingWinRate30d: null, sellCount30d: null };
  const quotaTrader = { globalScore: 20, tradingStyle: "tradea_cuota", swingPnl30d: 12, swingWinRate30d: 0.7, sellCount30d: 8 };
  const neither = { globalScore: 10, tradingStyle: "holdea", swingPnl30d: null, swingWinRate30d: null, sellCount30d: null };

  it("accepts a proven holder (score clears the gate) even with no swing record", () => {
    expect(isCryptoBookEligible(holder, 45)).toBe(true);
  });

  it("accepts a proven quota-trader (swing record) even with a low holder score", () => {
    // This is the fix: verified live 2026-07-13 that 27/29 tracked crypto
    // wallets round-trip fast BTC/ETH markets and never clear a holder-score
    // gate, even though several are proven profitable scalpers.
    expect(isCryptoBookEligible(quotaTrader, 45)).toBe(true);
  });

  it("rejects a wallet that clears neither bar", () => {
    expect(isCryptoBookEligible(neither, 45)).toBe(false);
  });

  it("a losing quota-trader does not get a free pass via the swing arm", () => {
    expect(isCryptoBookEligible({ ...quotaTrader, swingPnl30d: -5 }, 45)).toBe(false);
  });

  it("respects a raised score threshold for the holder arm", () => {
    expect(isCryptoBookEligible(holder, 70)).toBe(false);
  });
});

describe("crypto rule lineage (independent scope)", () => {
  it("seeds its own v1 from DEFAULT_CRYPTO_RULES", () => {
    const db = testDb();
    const { rules, version } = getActiveRules(db, "crypto");
    expect(version).toBe(1);
    expect(rules).toEqual(DEFAULT_CRYPTO_RULES);
  });

  it("versions independently from core, live and trade", () => {
    const db = testDb();
    getActiveRules(db, "core");
    getActiveRules(db, "live");
    getActiveRules(db, "trade");
    getActiveRules(db, "crypto");
    applyRuleChanges(
      db,
      [{ key: "minWalletGlobalScore", before: 45, after: 48, reason: "r", evidence: "e", expectedImprovement: "x" }],
      "crypto",
    );
    expect(getActiveRules(db, "core").version).toBe(1);
    expect(getActiveRules(db, "live").version).toBe(1);
    expect(getActiveRules(db, "trade").version).toBe(1);
    expect(getActiveRules(db, "crypto").version).toBe(2);
    const cryptoSets = db.select().from(ruleSets).where(eq(ruleSets.scope, "crypto")).all();
    expect(cryptoSets).toHaveLength(2);
  });
});
