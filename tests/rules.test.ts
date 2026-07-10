import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ruleChanges, ruleSets } from "@/db/schema";
import {
  applyRuleChanges,
  clampRuleValue,
  DEFAULT_RULES,
  getActiveRules,
  RULE_BOUNDS,
  type Rules,
} from "@/lib/rules";
import { testDb } from "./helpers/db";

describe("rule versioning", () => {
  it("seeds v1 defaults on first access", () => {
    const db = testDb();
    const { rules, version } = getActiveRules(db);
    expect(version).toBe(1);
    expect(rules.maxEntryPrice).toBe(0.82);
    expect(rules).toEqual(DEFAULT_RULES);
    expect(db.select().from(ruleSets).all()).toHaveLength(1);
  });

  it("is idempotent — repeated access does not create versions", () => {
    const db = testDb();
    getActiveRules(db);
    getActiveRules(db);
    expect(db.select().from(ruleSets).all()).toHaveLength(1);
  });

  it("applies an automatic change: new version, old deactivated, change logged", () => {
    const db = testDb();
    const before = getActiveRules(db);
    const newVersion = applyRuleChanges(db, [
      {
        key: "maxSpread",
        before: before.rules.maxSpread,
        after: 0.04,
        reason: "spread-heavy copies underperform",
        evidence: "6 settled copies with spreadScore<50 avg -$2.10",
        expectedImprovement: "fewer spread-tax losses",
      },
    ]);
    expect(newVersion).toBe(2);

    const active = getActiveRules(db);
    expect(active.version).toBe(2);
    expect(active.rules.maxSpread).toBe(0.04);
    // untouched values carried over
    expect(active.rules.maxEntryPrice).toBe(before.rules.maxEntryPrice);

    const old = db.select().from(ruleSets).where(eq(ruleSets.version, 1)).get()!;
    expect(old.active).toBe(false);

    const changes = db.select().from(ruleChanges).all();
    expect(changes).toHaveLength(1);
    expect(changes[0].changedBy).toBe("agent");
    expect(changes[0].reason).toMatch(/spread-heavy/);
    expect(JSON.parse(changes[0].beforeJson)).toEqual({ maxSpread: 0.05 });
    expect(JSON.parse(changes[0].afterJson)).toEqual({ maxSpread: 0.04 });
    expect(changes[0].evidenceSummary).toMatch(/6 settled/);
  });

  it("supports nested weight changes and preserves full history across versions", () => {
    const db = testDb();
    getActiveRules(db);
    applyRuleChanges(db, [
      { key: "walletWeights.consistency", before: 0.25, after: 0.3, reason: "r1", evidence: "e1", expectedImprovement: "x" },
    ]);
    applyRuleChanges(db, [
      { key: "minLiquidity", before: 500, after: 625, reason: "r2", evidence: "e2", expectedImprovement: "y" },
    ]);
    const active = getActiveRules(db);
    expect(active.version).toBe(3);
    expect(active.rules.walletWeights.consistency).toBe(0.3);
    expect(active.rules.minLiquidity).toBe(625);
    expect(db.select().from(ruleSets).all()).toHaveLength(3);
    expect(db.select().from(ruleChanges).all()).toHaveLength(2);
  });

  it("throws when called with no changes", () => {
    const db = testDb();
    expect(() => applyRuleChanges(db, [])).toThrow();
  });
});

describe("tuning bounds (safety rails)", () => {
  it("clamps every bounded rule into its allowed range", () => {
    for (const [key, bounds] of Object.entries(RULE_BOUNDS)) {
      expect(clampRuleValue(key, bounds.min - 1000)).toBe(bounds.min);
      expect(clampRuleValue(key, bounds.max + 1000)).toBe(bounds.max);
    }
  });
  it("never lets the entry-band ceiling drift to un-copyable extremes", () => {
    expect(clampRuleValue("maxEntryPrice", 0.99)).toBeLessThanOrEqual(0.9);
    expect(clampRuleValue("maxEntryPrice", 0.1)).toBeGreaterThanOrEqual(0.6);
  });
  it("default rules are within bounds", () => {
    const r = DEFAULT_RULES as unknown as Record<keyof Rules, number>;
    for (const [key, bounds] of Object.entries(RULE_BOUNDS)) {
      const v = r[key as keyof Rules];
      if (typeof v === "number") {
        expect(v).toBeGreaterThanOrEqual(bounds.min);
        expect(v).toBeLessThanOrEqual(bounds.max);
      }
    }
  });
});
