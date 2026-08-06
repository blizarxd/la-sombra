import { eq } from "drizzle-orm";
import { dailyPicks } from "@/db/schema";
import { fetchMarketsByConditionIds } from "@/lib/adapters";
import { pickPnl } from "@/lib/dailyPick";
import { log } from "@/lib/logger";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * Settle open daily picks against the market's real resolution.
 *
 * Only ever moves a pick from "abierto" to a final state. A settled pick is
 * never touched again and never deleted: the losers ARE the track record, and a
 * record you can edit afterwards proves nothing.
 */
runScript("pick:resolve", async (db) => {
  const open = db.select().from(dailyPicks).where(eq(dailyPicks.status, "abierto")).all();
  if (open.length === 0) {
    log.info("[pick:resolve] no hay picks abiertos");
    return;
  }

  const ids = [...new Set(open.map((p) => p.marketId))].filter((id) => id.startsWith("0x"));
  const markets = ids.length > 0 ? await fetchMarketsByConditionIds(ids) : [];
  const byId = new Map(markets.map((m) => [m.conditionId ?? m.marketId, m]));

  let settled = 0;
  for (const pick of open) {
    const market = byId.get(pick.marketId);
    if (!market?.resolved || market.winningOutcomeIndex === null) continue;

    const winner = market.outcomes[market.winningOutcomeIndex];
    let won: boolean | null = null;
    if (pick.outcome && winner) won = pick.outcome.toLowerCase() === winner.toLowerCase();
    else if (pick.tokenId) won = market.clobTokenIds.indexOf(pick.tokenId) === market.winningOutcomeIndex;

    if (won === null) {
      // Resolved but we cannot tell which side we were on. Voiding it is the
      // honest move — counting it as a win would be inventing a result, and
      // counting it as a loss would be inventing one too.
      db.update(dailyPicks)
        .set({ status: "anulado", resolvedAt: new Date(), pnlPer10: 0 })
        .where(eq(dailyPicks.id, pick.id))
        .run();
      log.warn(`[pick:resolve] ${pick.pickDate} anulado — resuelto pero no se pudo determinar el lado`);
      continue;
    }

    const pnl = pickPnl(pick.entryPrice, won);
    db.update(dailyPicks)
      .set({ status: won ? "ganado" : "perdido", resolvedAt: new Date(), pnlPer10: pnl })
      .where(eq(dailyPicks.id, pick.id))
      .run();
    settled++;
    log.info(`[pick:resolve] ${pick.pickDate} ${won ? "GANADO" : "PERDIDO"} · $${pnl?.toFixed(2)} por $10`);

    if (telegramConfigured()) {
      await sendTelegramMessage(
        `${won ? "✅" : "❌"} <b>Pick del ${pick.pickDate}</b>: ${won ? "GANADO" : "PERDIDO"}\n` +
          `${escapeHtml((pick.marketQuestion ?? pick.marketId).slice(0, 140))}\n` +
          `Entrada ${Math.round(pick.entryPrice * 100)}¢ → <b>$${pnl?.toFixed(2)}</b> por cada $10`,
      );
    }
  }

  log.info(`[pick:resolve] ${settled} liquidados de ${open.length} abiertos`);
});
