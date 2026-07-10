import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { ruleSets, ruleChanges } from "@/db/schema";
import { newId } from "./ids";

/**
 * Versioned, self-tunable rule set. The agent may change these values
 * automatically (paper trading only), but every change is logged with
 * reason + evidence + before/after in the rule_changes table.
 */
export interface Rules {
  // --- entry discipline (paper realism, learned from sibling project) ---
  maxEntryPrice: number; // skip paper BUY above this ask (default 0.82)
  minEntryPrice: number; // skip lottery-ticket entries below this
  maxPriceDrift: number; // late-entry guard: skip if price moved more than this since wallet entry
  maxSpread: number; // skip if book spread wider than this
  minLiquidity: number; // USD; skip markets thinner than this
  minTimeToResolutionHours: number;
  maxTimeToResolutionHours: number;
  // --- wallet gates ---
  minWalletGlobalScore: number; // 0-100
  minResolvedTrades: number; // wallet needs at least this many resolved trades
  oneHitWonderShareThreshold: number; // share of profit from top trade that triggers penalty
  // --- decision thresholds ---
  paperCopyThreshold: number; // copyScore >= this -> paper_copy
  watchlistThreshold: number; // copyScore >= this -> watchlist, else skip
  // --- sizing ---
  minPositionSize: number; // USD
  maxPositionSize: number; // USD
  // --- trade score weights (must sum to ~1) ---
  tradeWeights: {
    walletQuality: number;
    roi: number;
    consistency: number;
    copyability: number;
    categoryFit: number;
    entryTiming: number;
    spread: number;
    liquidity: number;
    thesis: number;
  };
  // --- wallet score weights ---
  walletWeights: {
    roi: number;
    consistency: number;
    copyability: number;
    categoryEdge: number;
  };
}

export const DEFAULT_RULES: Rules = {
  maxEntryPrice: 0.82,
  minEntryPrice: 0.1,
  maxPriceDrift: 0.08,
  maxSpread: 0.05,
  minLiquidity: 500,
  minTimeToResolutionHours: 4,
  maxTimeToResolutionHours: 24 * 45,
  minWalletGlobalScore: 55,
  minResolvedTrades: 5,
  oneHitWonderShareThreshold: 0.5,
  paperCopyThreshold: 65,
  watchlistThreshold: 45,
  minPositionSize: 5,
  maxPositionSize: 20,
  tradeWeights: {
    walletQuality: 0.2,
    roi: 0.08,
    consistency: 0.1,
    copyability: 0.15,
    categoryFit: 0.1,
    entryTiming: 0.12,
    spread: 0.1,
    liquidity: 0.08,
    thesis: 0.07,
  },
  walletWeights: {
    roi: 0.3,
    consistency: 0.25,
    copyability: 0.3,
    categoryEdge: 0.15,
  },
};

// Bounds the self-improvement loop must respect (safety rails on tuning).
export const RULE_BOUNDS: Record<string, { min: number; max: number }> = {
  maxEntryPrice: { min: 0.6, max: 0.9 },
  minEntryPrice: { min: 0.02, max: 0.3 },
  maxPriceDrift: { min: 0.02, max: 0.2 },
  maxSpread: { min: 0.01, max: 0.1 },
  minLiquidity: { min: 100, max: 10000 },
  minWalletGlobalScore: { min: 30, max: 80 },
  minResolvedTrades: { min: 3, max: 30 },
  oneHitWonderShareThreshold: { min: 0.3, max: 0.8 },
  paperCopyThreshold: { min: 50, max: 85 },
  watchlistThreshold: { min: 30, max: 60 },
};

export function clampRuleValue(key: string, value: number): number {
  const bounds = RULE_BOUNDS[key];
  if (!bounds) return value;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** Get the active rule set, seeding v1 defaults if the table is empty. */
export function getActiveRules(db: Db): { rules: Rules; version: number; id: string } {
  const active = db.select().from(ruleSets).where(eq(ruleSets.active, true)).get();
  if (active) {
    return { rules: JSON.parse(active.rulesJson) as Rules, version: active.version, id: active.id };
  }
  const now = new Date();
  const id = newId();
  db.insert(ruleSets)
    .values({
      id,
      version: 1,
      active: true,
      rulesJson: JSON.stringify(DEFAULT_RULES),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { rules: DEFAULT_RULES, version: 1, id };
}

export interface RuleChangeInput {
  key: string; // dot-path into Rules, e.g. "maxSpread"
  before: unknown;
  after: unknown;
  reason: string;
  evidence: string;
  expectedImprovement: string;
}

/**
 * Apply a set of rule changes: deactivates the current version, inserts a new
 * version, and logs one rule_changes row describing everything.
 * Returns the new version number.
 */
export function applyRuleChanges(db: Db, changes: RuleChangeInput[]): number {
  if (changes.length === 0) throw new Error("applyRuleChanges called with no changes");
  const current = getActiveRules(db);
  const newRules: Rules = JSON.parse(JSON.stringify(current.rules));
  for (const c of changes) {
    setPath(newRules as unknown as Record<string, unknown>, c.key, c.after);
  }
  const now = new Date();
  const newVersion = current.version + 1;
  const newId_ = newId();
  db.update(ruleSets).set({ active: false, updatedAt: now }).where(eq(ruleSets.id, current.id)).run();
  db.insert(ruleSets)
    .values({
      id: newId_,
      version: newVersion,
      active: true,
      rulesJson: JSON.stringify(newRules),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(ruleChanges)
    .values({
      id: newId(),
      oldRuleSetId: current.id,
      newRuleSetId: newId_,
      changedBy: "agent",
      reason: changes.map((c) => `${c.key}: ${c.reason}`).join(" | "),
      evidenceSummary: changes.map((c) => `${c.key}: ${c.evidence}`).join(" | "),
      beforeJson: JSON.stringify(Object.fromEntries(changes.map((c) => [c.key, c.before]))),
      afterJson: JSON.stringify(Object.fromEntries(changes.map((c) => [c.key, c.after]))),
      expectedImprovement: changes.map((c) => c.expectedImprovement).join(" | "),
      createdAt: now,
    })
    .run();
  return newVersion;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cursor = cursor[parts[i]] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

export function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], obj);
}
