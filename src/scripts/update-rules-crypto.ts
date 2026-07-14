import { and, eq, ne } from "drizzle-orm";
import { decisionJournal, paperTrades } from "@/db/schema";
import { log } from "@/lib/logger";
import { applyRuleChanges, clampRuleValue, getActiveRules, type RuleChangeInput } from "@/lib/rules";
import { runScript } from "./_runner";

/**
 * Self-improvement engine for the ₿ CRYPTO book — its OWN pace, OWN evidence,
 * OWN rule lineage (scope="crypto"). Reads only track="crypto" SETTLED trades
 * (resolved OR exit-closed on the wallet's sell) and tunes only the crypto
 * rule set. Same discipline as core/live/trade: bounded, versioned, logged.
 * Never touches other books.
 */

const MIN_SAMPLES = 8;

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

runScript("update:rules-crypto", async (db) => {
  const { rules, version } = getActiveRules(db, "crypto");

  const rows = db
    .select({
      realizedPnl: paperTrades.realizedPnl,
      entryPrice: paperTrades.entryPrice,
      walletAddress: paperTrades.walletAddress,
      obsId: decisionJournal.observedTradeId,
    })
    .from(paperTrades)
    .innerJoin(decisionJournal, eq(paperTrades.decisionJournalId, decisionJournal.id))
    .where(and(eq(paperTrades.track, "crypto"), ne(paperTrades.status, "open")))
    .all();

  if (rows.length < MIN_SAMPLES) {
    log.info(`[update:rules-crypto] only ${rows.length} settled crypto copies (need ${MIN_SAMPLES}) — holding v${version}`);
    return;
  }

  const pnls = rows.map((r) => r.realizedPnl ?? 0);
  const winRate = pnls.filter((p) => p > 0).length / pnls.length;
  log.info(`[update:rules-crypto] evidence: ${rows.length} settled crypto copies, win rate ${(winRate * 100).toFixed(0)}% (crypto rules v${version})`);

  const changes: RuleChangeInput[] = [];
  const propose = (key: string, before: number, after: number, reason: string, evidence: string, expected: string) => {
    const clamped = Math.round(clampRuleValue(key, after) * 10000) / 10000;
    if (clamped === before) return;
    changes.push({ key, before, after: clamped, reason, evidence, expectedImprovement: expected });
  };

  // 1) Overall crypto edge: raise/lower the holder-score arm of the wallet
  // eligibility gate (score-trades.ts also accepts swing-proven wallets
  // regardless of this value, so tightening here never blocks a proven
  // quota-trader — only the holder-score path).
  if (winRate < 0.45) {
    propose(
      "minWalletGlobalScore",
      rules.minWalletGlobalScore,
      rules.minWalletGlobalScore + 3,
      `crypto copies win only ${(winRate * 100).toFixed(0)}% (<45%)`,
      `${rows.length} settled crypto copies`,
      "copy only sharper crypto holders (swing-proven wallets are unaffected)",
    );
  } else if (winRate > 0.6 && rows.length >= 15) {
    propose(
      "minWalletGlobalScore",
      rules.minWalletGlobalScore,
      rules.minWalletGlobalScore - 2,
      `crypto copies win ${(winRate * 100).toFixed(0)}% — room to widen the net`,
      `${rows.length} settled crypto copies`,
      "capture more crypto edge",
    );
  }

  // 2) Top-of-band entries (near the expensive-favorite edge ~75¢): if they lose, lower maxEntryPrice.
  const expensive = rows.filter((r) => (r.entryPrice ?? 0) > rules.maxEntryPrice - 0.05);
  const expensiveAvg = avg(expensive.map((r) => r.realizedPnl ?? 0));
  if (expensive.length >= MIN_SAMPLES && (expensiveAvg ?? 0) < 0) {
    propose(
      "maxEntryPrice",
      rules.maxEntryPrice,
      rules.maxEntryPrice - 0.02,
      "top-of-band crypto entries (near the expensive favorite) lose",
      `${expensive.length} crypto copies with entry > ${(rules.maxEntryPrice - 0.05).toFixed(2)} avg $${expensiveAvg!.toFixed(2)}`,
      "tighter crypto entry band",
    );
  }

  // 3) Bottom-of-band entries (near the coin-flip ~55¢): if they lose, raise minEntryPrice.
  const cheap = rows.filter((r) => (r.entryPrice ?? 1) < rules.minEntryPrice + 0.05);
  const cheapAvg = avg(cheap.map((r) => r.realizedPnl ?? 0));
  if (cheap.length >= MIN_SAMPLES && (cheapAvg ?? 0) < 0) {
    propose(
      "minEntryPrice",
      rules.minEntryPrice,
      rules.minEntryPrice + 0.02,
      "coin-flip-zone crypto entries lose",
      `${cheap.length} crypto copies with entry < ${(rules.minEntryPrice + 0.05).toFixed(2)} avg $${cheapAvg!.toFixed(2)}`,
      "skip crypto coin-flips",
    );
  }

  if (changes.length > 0) {
    const newVersion = applyRuleChanges(db, changes, "crypto");
    log.info(`[update:rules-crypto] crypto rules v${version} -> v${newVersion}: ${changes.length} change(s)`);
    for (const c of changes) log.info(`  ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  } else {
    log.info("[update:rules-crypto] no crypto rule changes warranted by current evidence");
  }
});
