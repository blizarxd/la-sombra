import { log } from "@/lib/logger";
import { applyRuleChanges, getActiveRules, type RuleChangeInput } from "@/lib/rules";
import { runScript } from "./_runner";

/**
 * ONE-OFF manual rule adjustment (2026-07-15), applied by Johan's explicit
 * instruction after reviewing /matriz + the AI cut's "medio" recommendation
 * that a human decide on live's low-band bleed. Not an auto-tuner: no bounds
 * loop, no re-evaluation — a single deliberate change, logged like any other.
 *
 * live/minEntryPrice: /matriz (banda × brazo) shows live losing consistently
 * below 45¢ (30-44¢ ROI -9.8%, n=130; ≤29¢ ROI -8.2%) while 45-59¢ (+12.2%,
 * n=136) and 60-74¢ (+7.1%, n=157) are the profitable zone. Current floor
 * (0.26) still lets in most of the losing 30-44¢ band. Raise it to 0.45 —
 * right at the start of the winning zone. (RULE_BOUNDS.minEntryPrice max was
 * widened 0.3 -> 0.5 alongside this change so the live tuner doesn't clamp it
 * back down later.)
 *
 * Idempotent: only applies if the current value is still below target, so
 * re-running (or a stray extra forced tick) is a no-op.
 */
runScript("manual-tune:2026-07-15", async (db) => {
  const { rules } = getActiveRules(db, "live");
  const TARGET_MIN_ENTRY = 0.45;

  if (rules.minEntryPrice >= TARGET_MIN_ENTRY) {
    log.info(`[manual-tune] live.minEntryPrice already >= ${TARGET_MIN_ENTRY} (${rules.minEntryPrice}) — skipping`);
    return;
  }

  const changes: RuleChangeInput[] = [
    {
      key: "minEntryPrice",
      before: rules.minEntryPrice,
      after: TARGET_MIN_ENTRY,
      reason: "manual (Johan, 2026-07-15): live bleeds below 45¢, matches AI cut's own recommendation",
      evidence: "/matriz banda×brazo: live 30-44¢ ROI -9.8% n=130, ≤29¢ ROI -8.2%; 45-59¢ ROI +12.2% n=136",
      expectedImprovement: "stop live from opening lottery-ticket entries that the data shows losing",
    },
  ];

  const newVersion = applyRuleChanges(db, changes, "live", "johan-manual");
  log.info(`[manual-tune] live rules -> v${newVersion}: minEntryPrice ${rules.minEntryPrice} -> ${TARGET_MIN_ENTRY}`);
});
