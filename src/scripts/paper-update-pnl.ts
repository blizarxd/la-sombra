import { eq } from "drizzle-orm";
import { paperTrades } from "@/db/schema";
import { fetchMarketsByConditionIds, fetchOrderBook } from "@/lib/adapters";
import type { MarketInfo } from "@/lib/adapters/types";
import { log } from "@/lib/logger";
import { markPaperTrade, resolvePaperTrade } from "@/lib/paper/engine";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * Step 11 of the loop (run hourly): mark every open paper trade against the
 * live book (exit valued at the BID side — spread-honest) and settle trades
 * whose markets have resolved.
 */
runScript("paper:update-pnl", async (db) => {
  const open = db.select().from(paperTrades).where(eq(paperTrades.status, "open")).all();
  if (open.length === 0) {
    log.info("no open paper trades");
    return;
  }
  log.info(`updating ${open.length} open paper trades`);

  const marketCache = new Map<string, MarketInfo>();
  let marked = 0;
  let resolved = 0;

  for (const trade of open) {
    // 1) resolution check via gamma
    let market: MarketInfo | null = null;
    if (trade.marketId?.startsWith("0x")) {
      if (!marketCache.has(trade.marketId)) {
        const fetched = await fetchMarketsByConditionIds([trade.marketId]);
        if (fetched[0]) marketCache.set(trade.marketId, fetched[0]);
      }
      market = marketCache.get(trade.marketId) ?? null;
    }

    if (market?.resolved && market.winningOutcomeIndex !== null) {
      let won: boolean | null = null;
      const winnerName = market.outcomes[market.winningOutcomeIndex];
      if (trade.outcome && winnerName) won = trade.outcome.toLowerCase() === winnerName.toLowerCase();
      else if (trade.tokenId && market.clobTokenIds.length)
        won = market.clobTokenIds.indexOf(trade.tokenId) === market.winningOutcomeIndex;
      if (won !== null) {
        const { realizedPnl } = resolvePaperTrade(db, trade, won);
        log.info(`resolved ${trade.id.slice(0, 8)}… ${won ? "WON" : "LOST"} pnl $${realizedPnl.toFixed(2)}`);
        resolved++;
        // Real-time alert (optional): a paper trade just settled.
        if (telegramConfigured()) {
          const q = escapeHtml((trade.marketQuestion ?? trade.marketId).slice(0, 120));
          const ledger = trade.track === "live" ? " ⚡ EXPERIMENTO EN VIVO" : "";
          await sendTelegramMessage(
            `${won ? "✅ <b>GANADO</b>" : "❌ <b>PERDIDO</b>"} — trade en PAPEL resuelto${ledger}\n${q}\n` +
              `PnL $${realizedPnl.toFixed(2)} (tamaño $${trade.simulatedPositionSize.toFixed(2)})`,
          );
        }
        continue;
      }
    }

    // 2) hourly mark against the live book
    if (!trade.tokenId) {
      log.warn(`trade ${trade.id.slice(0, 8)}… has no tokenId; cannot mark (left as-is)`);
      continue;
    }
    try {
      const book = await fetchOrderBook(trade.tokenId);
      const mark = markPaperTrade(db, trade, book);
      if (mark) {
        marked++;
      } else {
        log.warn(`trade ${trade.id.slice(0, 8)}… book has no bids; mark skipped (real data only)`);
      }
    } catch (err) {
      log.warn(`book fetch failed for ${trade.id.slice(0, 8)}…: ${err instanceof Error ? err.message : err}`);
    }
  }
  log.info(`marked ${marked}, resolved ${resolved}`);
});
