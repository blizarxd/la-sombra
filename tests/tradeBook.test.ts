import { describe, expect, it } from "vitest";
import { isQuotaTraderEligible } from "@/lib/profiler";
import { DEFAULT_TRADE_RULES, applyRuleChanges, getActiveRules } from "@/lib/rules";
import { ruleSets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers/db";

describe("isQuotaTraderEligible (Trade book gate — swing record, not holder score)", () => {
  // A wallet with a real, winning, profitable swing record.
  const good = { tradingStyle: "tradea_cuota", swingPnl30d: 12, swingWinRate30d: 0.6, sellCount30d: 8 };

  it("accepts a profitable quota trader with a winning swing record", () => {
    expect(isQuotaTraderEligible(good)).toBe(true);
  });

  it("accepts a profitable mixed-style wallet", () => {
    expect(isQuotaTraderEligible({ ...good, tradingStyle: "mixto", swingPnl30d: 3 })).toBe(true);
  });

  it("rejects a pure holder", () => {
    expect(isQuotaTraderEligible({ ...good, tradingStyle: "holdea" })).toBe(false);
  });

  it("rejects a quota trader whose swing loses money", () => {
    expect(isQuotaTraderEligible({ ...good, swingPnl30d: -4 })).toBe(false);
  });

  it("rejects too few matched exits (not enough evidence)", () => {
    expect(isQuotaTraderEligible({ ...good, sellCount30d: 2 })).toBe(false);
  });

  it("rejects a losing swing win-rate even if PnL squeaks positive", () => {
    expect(isQuotaTraderEligible({ ...good, swingWinRate30d: 0.3 })).toBe(false);
  });

  it("rejects when style/swing not yet profiled (nulls)", () => {
    expect(
      isQuotaTraderEligible({ tradingStyle: null, swingPnl30d: null, swingWinRate30d: null, sellCount30d: null }),
    ).toBe(false);
  });

  it("requires strictly positive swing PnL", () => {
    expect(isQuotaTraderEligible({ ...good, swingPnl30d: 0 })).toBe(false);
  });
});

describe("trade rule lineage (independent scope)", () => {
  it("seeds its own v1 from DEFAULT_TRADE_RULES", () => {
    const db = testDb();
    const { rules, version } = getActiveRules(db, "trade");
    expect(version).toBe(1);
    expect(rules).toEqual(DEFAULT_TRADE_RULES);
    expect(rules.minTimeToResolutionHours).toBe(0); // scalps close before resolution
    expect(rules.maxPositionSize).toBe(5); // fixed small scalp size
  });

  it("versions independently from core and live", () => {
    const db = testDb();
    getActiveRules(db, "core");
    getActiveRules(db, "live");
    getActiveRules(db, "trade");
    applyRuleChanges(
      db,
      [{ key: "minWalletGlobalScore", before: 55, after: 58, reason: "r", evidence: "e", expectedImprovement: "x" }],
      "trade",
    );
    // core + live still at v1, trade advanced to v2
    expect(getActiveRules(db, "core").version).toBe(1);
    expect(getActiveRules(db, "live").version).toBe(1);
    expect(getActiveRules(db, "trade").version).toBe(2);
    const tradeSets = db.select().from(ruleSets).where(eq(ruleSets.scope, "trade")).all();
    expect(tradeSets).toHaveLength(2);
  });
});
