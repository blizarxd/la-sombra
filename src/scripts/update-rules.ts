import { eq } from "drizzle-orm";
import { decisionJournal, outcomeReviews, paperTrades, walletProfiles } from "@/db/schema";
import { log } from "@/lib/logger";
import { applyRuleChanges, clampRuleValue, getActiveRules, type RuleChangeInput } from "@/lib/rules";
import { runScript } from "./_runner";

/**
 * Step 13 of the loop: the self-improvement engine.
 *
 * Looks at RESOLVED evidence (outcome reviews + settled paper trades) and
 * tunes rule thresholds in small, bounded steps. No approval needed (paper
 * trading only) but EVERY change is versioned and logged with reason,
 * evidence, before and after in rule_changes.
 *
 * Also downgrades wallets whose copied trades keep losing (profile-level
 * change, noted on the wallet, not a rule change).
 */

interface Sample {
  pnl: number;
  spreadScore: number | null;
  entryTimingScore: number | null;
  liquidityScore: number | null;
  copyScore: number;
  entryPrice: number | null;
  consistencyScore: number | null;
}

const MIN_SAMPLES = 5;

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

runScript("update:rules", async (db) => {
  const { rules, version } = getActiveRules(db);

  // ---- gather resolved evidence: copies with settled pnl ----
  const reviews = db.select().from(outcomeReviews).all();
  const settled = reviews.filter((r) => r.finalOutcome === "won" || r.finalOutcome === "lost");
  const decisions = db.select().from(decisionJournal).all();
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const trades = db.select().from(paperTrades).all();
  const tradeByDecision = new Map(trades.map((t) => [t.decisionJournalId, t]));

  const copySamples: Sample[] = [];
  for (const r of settled) {
    const d = decisionById.get(r.decisionJournalId);
    if (!d || d.decision !== "paper_copy") continue;
    const t = tradeByDecision.get(d.id);
    copySamples.push({
      pnl: r.simulatedPnl ?? t?.realizedPnl ?? 0,
      spreadScore: d.spreadScore,
      entryTimingScore: d.entryTimingScore,
      liquidityScore: d.liquidityScore,
      copyScore: d.copyScore,
      entryPrice: t?.entryPrice ?? null,
      consistencyScore: d.consistencyScore,
    });
  }
  const missedWinners = settled.filter((r) => {
    const d = decisionById.get(r.decisionJournalId);
    return d && d.decision !== "paper_copy" && (r.simulatedPnl ?? 0) > 0;
  }).length;
  const nonCopySettled = settled.filter((r) => decisionById.get(r.decisionJournalId)?.decision !== "paper_copy").length;

  log.info(`evidence: ${copySamples.length} settled copies, ${nonCopySettled} settled non-copies (rule set v${version})`);

  const changes: RuleChangeInput[] = [];
  const propose = (key: string, before: number, after: number, reason: string, evidence: string, expected: string) => {
    const clamped = Math.round(clampRuleValue(key, after) * 10000) / 10000;
    if (clamped === before) return;
    changes.push({ key, before, after: clamped, reason, evidence, expectedImprovement: expected });
  };

  // 1) Spread: if spread-heavy copies lose money, tighten maxSpread.
  const spreadHeavy = copySamples.filter((s) => (s.spreadScore ?? 100) < 50);
  const spreadHeavyAvg = avg(spreadHeavy.map((s) => s.pnl));
  if (spreadHeavy.length >= MIN_SAMPLES && (spreadHeavyAvg ?? 0) < 0) {
    propose(
      "maxSpread",
      rules.maxSpread,
      rules.maxSpread - 0.005,
      "spread-heavy copies underperform",
      `${spreadHeavy.length} settled copies with spreadScore<50 avg $${spreadHeavyAvg!.toFixed(2)}`,
      "fewer spread-tax losses",
    );
  }

  // 2) Late entries: if low entry-timing copies lose, tighten maxPriceDrift.
  const late = copySamples.filter((s) => (s.entryTimingScore ?? 100) < 60);
  const lateAvg = avg(late.map((s) => s.pnl));
  if (late.length >= MIN_SAMPLES && (lateAvg ?? 0) < 0) {
    propose(
      "maxPriceDrift",
      rules.maxPriceDrift,
      rules.maxPriceDrift - 0.01,
      "late entries (big drift since wallet entry) lose",
      `${late.length} settled copies with entryTimingScore<60 avg $${lateAvg!.toFixed(2)}`,
      "avoid chasing moved prices",
    );
  }

  // 3) Liquidity: if thin-market copies lose, raise minLiquidity.
  const thin = copySamples.filter((s) => (s.liquidityScore ?? 100) < 60);
  const thinAvg = avg(thin.map((s) => s.pnl));
  if (thin.length >= MIN_SAMPLES && (thinAvg ?? 0) < 0) {
    propose(
      "minLiquidity",
      rules.minLiquidity,
      Math.round(rules.minLiquidity * 1.25),
      "thin-market copies underperform",
      `${thin.length} settled copies with liquidityScore<60 avg $${thinAvg!.toFixed(2)}`,
      "skip unfollowable books",
    );
  }

  // 4) Copy threshold: overall copy win rate too low -> stricter; many missed winners -> slightly looser.
  if (copySamples.length >= 10) {
    const winRate = copySamples.filter((s) => s.pnl > 0).length / copySamples.length;
    if (winRate < 0.45) {
      propose(
        "paperCopyThreshold",
        rules.paperCopyThreshold,
        rules.paperCopyThreshold + 2,
        `copy win rate ${(winRate * 100).toFixed(0)}% < 45%`,
        `${copySamples.length} settled copies`,
        "be pickier",
      );
    } else if (winRate > 0.6 && nonCopySettled >= 10 && missedWinners / nonCopySettled > 0.5) {
      propose(
        "paperCopyThreshold",
        rules.paperCopyThreshold,
        rules.paperCopyThreshold - 1,
        `copies win ${(winRate * 100).toFixed(0)}% but ${missedWinners}/${nonCopySettled} non-copies were missed winners`,
        "outcome reviews of watchlist/skip decisions",
        "capture more of the edge",
      );
    }
  }

  // 5) Entry band: if high-priced entries lose, lower maxEntryPrice.
  const expensive = copySamples.filter((s) => (s.entryPrice ?? 0) > rules.maxEntryPrice - 0.07);
  const expensiveAvg = avg(expensive.map((s) => s.pnl));
  if (expensive.length >= MIN_SAMPLES && (expensiveAvg ?? 0) < 0) {
    propose(
      "maxEntryPrice",
      rules.maxEntryPrice,
      rules.maxEntryPrice - 0.02,
      "entries near the top of the band lose",
      `${expensive.length} settled copies with entry > ${(rules.maxEntryPrice - 0.07).toFixed(2)} avg $${expensiveAvg!.toFixed(2)}`,
      "tighter entry-band discipline",
    );
  }

  // 6) Consistency weighting: if copies from inconsistent wallets lose, shift weight ROI -> consistency.
  const inconsistent = copySamples.filter((s) => (s.consistencyScore ?? 100) < 50);
  const inconsistentAvg = avg(inconsistent.map((s) => s.pnl));
  if (inconsistent.length >= MIN_SAMPLES && (inconsistentAvg ?? 0) < 0 && rules.walletWeights.roi >= 0.15) {
    changes.push({
      key: "walletWeights.consistency",
      before: rules.walletWeights.consistency,
      after: Math.round((rules.walletWeights.consistency + 0.05) * 100) / 100,
      reason: "copies from inconsistent wallets lose",
      evidence: `${inconsistent.length} settled copies with consistencyScore<50 avg $${inconsistentAvg!.toFixed(2)}`,
      expectedImprovement: "prefer steady wallets over hot streaks",
    });
    changes.push({
      key: "walletWeights.roi",
      before: rules.walletWeights.roi,
      after: Math.round((rules.walletWeights.roi - 0.05) * 100) / 100,
      reason: "counterweight for consistency increase",
      evidence: "same evidence as walletWeights.consistency",
      expectedImprovement: "keep weights normalized",
    });
  }

  if (changes.length > 0) {
    const newVersion = applyRuleChanges(db, changes);
    log.info(`rule set v${version} -> v${newVersion}: ${changes.length} change(s)`);
    for (const c of changes) log.info(`  ${c.key}: ${c.before} -> ${c.after} (${c.reason})`);
  } else {
    log.info("no rule changes warranted by current evidence");
  }

  // ---- wallet downgrades based on realized paper performance ----
  const perByWallet = new Map<string, { pnl: number; n: number }>();
  for (const t of trades) {
    if (t.status !== "resolved") continue;
    const cur = perByWallet.get(t.walletAddress) ?? { pnl: 0, n: 0 };
    cur.pnl += t.realizedPnl ?? 0;
    cur.n += 1;
    perByWallet.set(t.walletAddress, cur);
  }
  let downgrades = 0;
  for (const [address, perf] of perByWallet) {
    if (perf.n < 3 || perf.pnl >= -5) continue;
    const wallet = db.select().from(walletProfiles).where(eq(walletProfiles.address, address)).get();
    if (!wallet || wallet.status === "ignore") continue;
    const newStatus = perf.pnl < -10 ? "ignore" : "watch";
    if (newStatus === wallet.status) continue;
    const note = `auto-downgrade ${wallet.status} -> ${newStatus}: ${perf.n} resolved copies, paper pnl $${perf.pnl.toFixed(2)} (${new Date().toISOString()})`;
    db.update(walletProfiles)
      .set({
        status: newStatus,
        riskNotes: wallet.riskNotes ? `${wallet.riskNotes}; ${note}` : note,
        updatedAt: new Date(),
      })
      .where(eq(walletProfiles.id, wallet.id))
      .run();
    log.info(`wallet ${address.slice(0, 10)}… ${note}`);
    downgrades++;
  }
  if (downgrades === 0) log.info("no wallet downgrades needed");
});
