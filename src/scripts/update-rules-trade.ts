import { and, eq, ne } from "drizzle-orm";
import { decisionJournal, paperTrades } from "@/db/schema";
import { log } from "@/lib/logger";
import { applyRuleChanges, clampRuleValue, getActiveRules, type RuleChangeInput } from "@/lib/rules";
import { runScript } from "./_runner";

/**
 * Self-improvement engine for the 🔁 TRADE book (quota-scalper experiment) —
 * its OWN pace, OWN evidence, OWN rule lineage (scope="trade"). It only reads
 * track="trade" SETTLED trades (resolved OR exit-closed, since scalps close on
 * the wallet's sell) and only tunes the trade rule set. Bounded, versioned,
 * logged — same discipline as the core/live tuners. Never touches other books.
 */

const MIN_SAMPLES = 8;

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

runScript("update:rules-trade", async (db) => {
  const { rules, version } = getActiveRules(db, "trade");

  const rows = db
    .select({
      realizedPnl: paperTrades.realizedPnl,
      entryPrice: paperTrades.entryPrice,
      walletAddress: paperTrades.walletAddress,
      obsId: decisionJournal.observedTradeId,
    })
    .from(paperTrades)
    .innerJoin(decisionJournal, eq(paperTrades.decisionJournalId, decisionJournal.id))
    .where(and(eq(paperTrades.track, "trade"), ne(paperTrades.status, "open")))
    .all();

  if (rows.length < MIN_SAMPLES) {
    log.info(`[update:rules-trade] only ${rows.length} settled scalps (need ${MIN_SAMPLES}) — holding v${version}`);
    return;
  }

  const pnls = rows.map((r) => r.realizedPnl ?? 0);
  const winRate = pnls.filter((p) => p > 0).length / pnls.length;
  log.info(`[update:rules-trade] evidence: ${rows.length} settled scalps, win rate ${(winRate * 100).toFixed(0)}% (trade rules v${version})`);

  const changes: RuleChangeInput[] = [];
  const propose = (key: string, before: number, after: number, reason: string, evidence: string, expected: string) => {
    const clamped = Math.round(clampRuleValue(key, after) * 10000) / 10000;
    if (clamped === before) return;
    changes.push({ key, before, after: clamped, reason, evidence, expectedImprovement: expected });
  };

  // 1) Overall scalp edge: tighten/loosen the wallet-quality gate.
  if (winRate < 0.45) {
    propose(
      "minWalletGlobalScore",
      rules.minWalletGlobalScore,
      rules.minWalletGlobalScore + 3,
      `scalp copies win only ${(winRate * 100).toFixed(0)}% (<45%)`,
      `${rows.length} settled scalps`,
      "copy only sharper quota-traders",
    );
  } else if (winRate > 0.6 && rows.length >= 15) {
    propose(
      "minWalletGlobalScore",
      rules.minWalletGlobalScore,
      rules.minWalletGlobalScore - 2,
      `scalp copies win ${(winRate * 100).toFixed(0)}% — room to widen the net`,
      `${rows.length} settled scalps`,
      "capture more scalp edge",
    );
  }

  // 2) Late entry hurts scalps most: if wide-drift-tolerant entries bleed, tighten drift.
  const expensive = rows.filter((r) => (r.entryPrice ?? 0) > rules.maxEntryPrice - 0.07);
  const expensiveAvg = avg(expensive.map((r) => r.realizedPnl ?? 0));
  if (expensive.length >= MIN_SAMPLES && (expensiveAvg ?? 0) < 0) {
    propose(
      "maxEntryPrice",
      rules.maxEntryPrice,
      rules.maxEntryPrice - 0.02,
      "top-of-band scalp entries lose",
      `${expensive.length} scalps with entry > ${(rules.maxEntryPrice - 0.07).toFixed(2)} avg $${expensiveAvg!.toFixed(2)}`,
      "tighter scalp entry band",
    );
  }

  if (changes.length > 0) {
    const newVersion = applyRuleChanges(db, changes, "trade");
    log.info(`[update:rules-trade] trade rules v${version} -> v${newVersion}: ${changes.length} change(s)`);
    for (const c of changes) log.info(`  ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  } else {
    log.info("[update:rules-trade] no trade rule changes warranted by current evidence");
  }
});
