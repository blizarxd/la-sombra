import { applyRuleChanges, getActiveRules } from "@/lib/rules";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * Manual policy guard (Johan): the core book must not copy markets that resolve
 * more than CORE_MAX_RESOLUTION_DAYS out — long-dated copies pile up open
 * positions and park capital. This is NOT AI-tunable; it's a hard human policy.
 *
 * Idempotent: only acts if the active core window is wider than the cap, and
 * once applied it no-ops forever. Runs every tick (cheap: one read). Applying it
 * as a versioned rule change keeps it logged and visible on the Reglas page.
 */
const CORE_MAX_RESOLUTION_DAYS = 30;
const CORE_MAX_RESOLUTION_HOURS = 24 * CORE_MAX_RESOLUTION_DAYS;

runScript("enforce:core-policy", (db) => {
  const { rules } = getActiveRules(db, "core");
  if (rules.maxTimeToResolutionHours <= CORE_MAX_RESOLUTION_HOURS) {
    log.info(`[enforce:core-policy] max resolution already ≤ ${CORE_MAX_RESOLUTION_DAYS}d — no change`);
    return;
  }
  const before = rules.maxTimeToResolutionHours;
  const version = applyRuleChanges(
    db,
    [
      {
        key: "maxTimeToResolutionHours",
        before,
        after: CORE_MAX_RESOLUTION_HOURS,
        reason: `política manual: no copiar mercados a más de ${CORE_MAX_RESOLUTION_DAYS} días (capital parado)`,
        evidence: `abiertas se acumulaban con cola de ${Math.round(before / 24)}d`,
        expectedImprovement: "menos posiciones abiertas y feedback realizado más rápido",
      },
    ],
    "core",
    "manual-policy",
  );
  log.info(
    `[enforce:core-policy] core maxTimeToResolutionHours ${before} → ${CORE_MAX_RESOLUTION_HOURS} (core rules v${version})`,
  );
});
