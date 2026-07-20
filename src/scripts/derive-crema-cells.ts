import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { cremaCells, cremaEvolution, paperTrades } from "@/db/schema";
import { loadAllCells, seedCells } from "@/lib/cremaCells";
import { applyScan, scanCells, type CellEvent, type CellRow } from "@/lib/goldEngine";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * 🧬 Daily gold derivation — the step that makes La Crema SELF-EVOLVING.
 *
 * Re-runs the full matrix scan (goldEngine.scanCells) over every settled paper
 * trade of the SOURCE arms and folds the result into `crema_cells` with the
 * pre-registered hysteresis: a cell needs 2 consecutive scans as a survivor to
 * activate, and 2 consecutive failing scans to be pruned. Every transition is
 * appended to `crema_evolution` (and pushed to Telegram) so the strategy keeps
 * an auditable diary of what it learned and when.
 *
 * Scan input excludes:
 *   · elite — the hybrid must never derive its rules from its own copies
 *     (self-reference would make every active cell look self-confirming), and
 *   · combo — parlay economics (longshot payouts, leg-based settlement) would
 *     poison per-cell ROI.
 *
 * Paper only, read-only on trades: this writes cell rows and log lines, never
 * positions and never orders.
 */
runScript("derive:crema-cells", async (db) => {
  const now = Date.now();

  // Bootstrap: first run seeds the manually-scanned 2026-07-20 rule set as
  // active, so the hybrid never has a "no rules yet" gap.
  const existingCount = db.select({ n: sql<number>`count(*)` }).from(cremaCells).get()?.n ?? 0;
  if (existingCount === 0) {
    for (const cell of seedCells()) {
      persistCell(db, cell, now);
      logEvent(db, now, { cellId: cell.id, action: "semilla", detail: `${cell.label} — activada desde el barrido manual del 20-jul` });
    }
    log.info(`[derive:crema-cells] seeded ${seedCells().length} cells from the 2026-07-20 manual scan`);
  }

  const settled = db
    .select({
      track: paperTrades.track,
      entryPrice: paperTrades.entryPrice,
      simulatedPositionSize: paperTrades.simulatedPositionSize,
      realizedPnl: paperTrades.realizedPnl,
      openedAt: paperTrades.openedAt,
      marketQuestion: paperTrades.marketQuestion,
    })
    .from(paperTrades)
    .where(sql`${paperTrades.status} != 'open' AND ${paperTrades.track} IN ('core','live','trade','crypto')`)
    .all();

  const scan = scanCells(settled, now);
  log.info(
    `[derive:crema-cells] scanned ${settled.length} settled source trades → ${scan.gold.length} gold survivors, ${scan.traps.length} traps`,
  );

  const { rows, events } = applyScan(loadAllCells(db), scan, now);
  for (const row of rows) persistCell(db, row, now);
  for (const ev of events) logEvent(db, now, ev);

  const active = rows.filter((r) => r.status === "activa");
  log.info(
    `[derive:crema-cells] active set: ${active.filter((r) => r.kind === "gold").length} gold + ${
      active.filter((r) => r.kind === "trap").length
    } traps · events: ${events.map((e) => `${e.action}:${e.cellId}`).join(", ") || "none"}`,
  );

  // Only true transitions deserve a ping — candidatas are routine.
  const notable = events.filter((e) => ["activada", "podada", "reactivada"].includes(e.action));
  if (notable.length > 0 && telegramConfigured()) {
    const lines = notable.map((e) => `· <b>${e.action.toUpperCase()}</b> ${escapeHtml(e.detail)}`).join("\n");
    await sendTelegramMessage(`🧬 <b>La Crema evolucionó</b> (escaneo diario de oro)\n${lines}`);
  }
});

function persistCell(db: Db, cell: CellRow, now: number): void {
  const values = {
    id: cell.id,
    kind: cell.kind,
    label: cell.label,
    paramsJson: JSON.stringify(cell.params),
    status: cell.status,
    hits: cell.hits,
    misses: cell.misses,
    evidenceJson: cell.windows ? JSON.stringify(cell.windows) : null,
    firstSeenAt: new Date(cell.firstSeenAt),
    activatedAt: cell.activatedAt ? new Date(cell.activatedAt) : null,
    retiredAt: cell.retiredAt ? new Date(cell.retiredAt) : null,
    updatedAt: new Date(now),
  };
  db.insert(cremaCells)
    .values(values)
    .onConflictDoUpdate({ target: cremaCells.id, set: values })
    .run();
}

function logEvent(db: Db, now: number, ev: CellEvent): void {
  db.insert(cremaEvolution)
    .values({ id: newId(), at: new Date(now), cellId: ev.cellId, action: ev.action, detail: ev.detail })
    .run();
}
