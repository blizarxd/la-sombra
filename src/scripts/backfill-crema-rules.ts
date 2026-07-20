import { and, eq, gte, isNull } from "drizzle-orm";
import { paperTrades } from "@/db/schema";
import { categorizeMarket } from "@/lib/category";
import { CREMA_REBUILD_MS, isCremaGoldCell } from "@/lib/cremaCells";
import { hourInAppTz } from "@/lib/format";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * One-off, idempotent: stamp gold_rule on La Crema copies opened AFTER the
 * 2026-07-18 rebuild.
 *
 * The gold_rule column landed on 2026-07-20, two days after the matrix-driven
 * gate went live — so the copies from those two days are new-design but carry a
 * null rule, which makes them read as "legacy" and leaves the new experiment
 * showing $0.00. Timestamp is the ground truth for WHICH design opened a trade
 * (the gate changed at a known moment), so the generation is backfilled from
 * openedAt and the specific rule is recomputed from the trade's own stored
 * facts (question -> category, openedAt -> hour, entryPrice).
 *
 * Honest caveat, encoded: the gate was TIGHTENED on 2026-07-20 (esports went
 * from any-band to <60¢). A copy from the first version that today's rule would
 * not accept is stamped "regla-v1" rather than silently attributed to a current
 * rule — it belongs to the new design but entered under looser terms, and the
 * panel must not pretend otherwise.
 *
 * Read-only on decisions; paper only; touches nothing but this label.
 */
runScript("backfill:crema-rules", async (db) => {
  const pending = db
    .select()
    .from(paperTrades)
    .where(
      and(
        eq(paperTrades.track, "elite"),
        isNull(paperTrades.goldRule),
        gte(paperTrades.openedAt, new Date(CREMA_REBUILD_MS)),
      ),
    )
    .all();

  if (pending.length === 0) {
    log.info("[backfill:crema-rules] nothing to stamp — every post-rebuild copy already has its rule");
    return;
  }

  const counts: Record<string, number> = {};
  for (const t of pending) {
    const verdict = isCremaGoldCell(
      categorizeMarket(t.marketQuestion),
      hourInAppTz(t.openedAt),
      t.entryPrice,
    );
    const rule = verdict.gold && verdict.rule ? verdict.rule : "regla-v1";
    db.update(paperTrades).set({ goldRule: rule }).where(eq(paperTrades.id, t.id)).run();
    counts[rule] = (counts[rule] ?? 0) + 1;
  }

  log.info(
    `[backfill:crema-rules] stamped ${pending.length} post-rebuild copies: ` +
      Object.entries(counts)
        .map(([r, n]) => `${r}=${n}`)
        .join(", "),
  );
});
