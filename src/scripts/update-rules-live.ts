import { and, eq } from "drizzle-orm";
import { decisionJournal, observedTrades, paperTrades } from "@/db/schema";
import { log } from "@/lib/logger";
import { applyRuleChanges, clampRuleValue, getActiveRules, type RuleChangeInput } from "@/lib/rules";
import { runScript } from "./_runner";

/**
 * Self-improvement engine for the ⚡ LIVE experiment — its OWN pace, its OWN
 * evidence, its OWN rule lineage (scope="live"). It only ever reads track="live"
 * resolved trades and only tunes the live rule set. It never touches the core
 * strategy. Same discipline as the core tuner: bounded steps, versioned, logged.
 */

const MIN_SAMPLES = 8; // live resolves fast, so ask for a little more evidence

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

runScript("update:rules-live", async (db) => {
  const { rules, version } = getActiveRules(db, "live");

  // Resolved LIVE paper trades, joined to their observed trade for entry price.
  const rows = db
    .select({
      realizedPnl: paperTrades.realizedPnl,
      entryPrice: paperTrades.entryPrice,
      spread: paperTrades.spreadCostPaid,
      walletAddress: paperTrades.walletAddress,
      obsId: decisionJournal.observedTradeId,
    })
    .from(paperTrades)
    .innerJoin(decisionJournal, eq(paperTrades.decisionJournalId, decisionJournal.id))
    .where(and(eq(paperTrades.track, "live"), eq(paperTrades.status, "resolved")))
    .all();

  if (rows.length < MIN_SAMPLES) {
    log.info(`[update:rules-live] only ${rows.length} resolved live copies (need ${MIN_SAMPLES}) — holding v${version}`);
    return;
  }

  const pnls = rows.map((r) => r.realizedPnl ?? 0);
  const winRate = pnls.filter((p) => p > 0).length / pnls.length;
  log.info(`[update:rules-live] evidence: ${rows.length} resolved live copies, win rate ${(winRate * 100).toFixed(0)}% (live rules v${version})`);

  const changes: RuleChangeInput[] = [];
  const propose = (key: string, before: number, after: number, reason: string, evidence: string, expected: string) => {
    const clamped = Math.round(clampRuleValue(key, after) * 10000) / 10000;
    if (clamped === before) return;
    changes.push({ key, before, after: clamped, reason, evidence, expectedImprovement: expected });
  };

  // 1) Overall live edge: raise/lower the wallet-quality gate on results.
  if (winRate < 0.45) {
    propose(
      "minWalletGlobalScore",
      rules.minWalletGlobalScore,
      rules.minWalletGlobalScore + 3,
      `live copies win only ${(winRate * 100).toFixed(0)}% (<45%)`,
      `${rows.length} resolved live copies`,
      "copy only sharper live bettors",
    );
  } else if (winRate > 0.6 && rows.length >= 15) {
    propose(
      "minWalletGlobalScore",
      rules.minWalletGlobalScore,
      rules.minWalletGlobalScore - 2,
      `live copies win ${(winRate * 100).toFixed(0)}% — room to widen the net`,
      `${rows.length} resolved live copies`,
      "capture more live edge",
    );
  }

  // 2) Entry band: if expensive live entries bleed, lower maxEntryPrice.
  const expensive = rows.filter((r) => (r.entryPrice ?? 0) > rules.maxEntryPrice - 0.07);
  const expensiveAvg = avg(expensive.map((r) => r.realizedPnl ?? 0));
  if (expensive.length >= MIN_SAMPLES && (expensiveAvg ?? 0) < 0) {
    propose(
      "maxEntryPrice",
      rules.maxEntryPrice,
      rules.maxEntryPrice - 0.02,
      "top-of-band live entries lose",
      `${expensive.length} live copies with entry > ${(rules.maxEntryPrice - 0.07).toFixed(2)} avg $${expensiveAvg!.toFixed(2)}`,
      "tighter live entry band",
    );
  }

  // 3) Cheap lottery entries: if very-low-price live entries lose, raise minEntryPrice.
  const cheap = rows.filter((r) => (r.entryPrice ?? 1) < rules.minEntryPrice + 0.08);
  const cheapAvg = avg(cheap.map((r) => r.realizedPnl ?? 0));
  if (cheap.length >= MIN_SAMPLES && (cheapAvg ?? 0) < 0) {
    propose(
      "minEntryPrice",
      rules.minEntryPrice,
      rules.minEntryPrice + 0.02,
      "cheap live lottery entries lose",
      `${cheap.length} live copies with entry < ${(rules.minEntryPrice + 0.08).toFixed(2)} avg $${cheapAvg!.toFixed(2)}`,
      "skip live longshots",
    );
  }

  if (changes.length > 0) {
    const newVersion = applyRuleChanges(db, changes, "live");
    log.info(`[update:rules-live] live rules v${version} -> v${newVersion}: ${changes.length} change(s)`);
    for (const c of changes) log.info(`  ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  } else {
    log.info("[update:rules-live] no live rule changes warranted by current evidence");
  }
});
