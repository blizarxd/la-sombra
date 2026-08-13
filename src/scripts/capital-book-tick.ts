import { asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { capitalBook, paperTrades } from "@/db/schema";
import {
  CAPITAL_START,
  FLAT_STAKE,
  MAX_CONCURRENT,
  armExitPrice,
  concurrentAt,
  decide,
  isEligible,
  settledPnl,
} from "@/lib/capitalBook";
import { categorizeMarket } from "@/lib/category";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * 💰 CAPITAL BOOK tick.
 *
 * Mirrors qualifying arm copies into ONE simulated bankroll under hard rules
 * (fixed capital, flat stake, max concurrent positions) and settles them when
 * the underlying copy settles.
 *
 * Two properties this depends on:
 *
 * 1. It processes new signals in openedAt ORDER and judges concurrency at each
 *    signal's own timestamp — not at tick time. So a signal that arrived while
 *    three positions were live is skipped even if two have closed by the time
 *    we look. Running late must not make the book look luckier than it was.
 *
 * 2. It never re-decides a signal (unique index on paper_trade_id). Once taken
 *    or skipped, that verdict stands.
 *
 * SAFETY: paper only. It reads existing simulated copies and writes simulated
 * bookkeeping. It places nothing.
 */

runScript("capital-book-tick", async (db) => {
  // ---- 1. Settle entries whose underlying copy has finished --------------
  const openEntries = db.select().from(capitalBook).where(eq(capitalBook.status, "open")).all();
  let settled = 0;
  if (openEntries.length) {
    const underlying = db
      .select()
      .from(paperTrades)
      .where(inArray(paperTrades.id, openEntries.map((e) => e.paperTradeId)))
      .all();
    const byId = new Map(underlying.map((t) => [t.id, t]));
    for (const entry of openEntries) {
      const t = byId.get(entry.paperTradeId);
      if (!t || t.status === "open") continue;
      const exit = armExitPrice(t);
      if (exit === null || entry.entryPrice === null) continue;
      const pnl = settledPnl(entry.entryPrice, entry.stake, exit);
      db.update(capitalBook)
        .set({
          status: t.status === "resolved" ? "resolved" : "closed",
          realizedPnl: pnl,
          closedAt: t.resolvedAt ?? t.closedAt ?? new Date(),
        })
        .where(eq(capitalBook.id, entry.id))
        .run();
      settled += 1;
    }
  }

  // ---- 2. Consider new signals, oldest first ------------------------------
  const alreadySeen = new Set(
    db.select({ paperTradeId: capitalBook.paperTradeId }).from(capitalBook).all().map((r) => r.paperTradeId),
  );
  const candidates = db
    .select()
    .from(paperTrades)
    // No ladder means no measured price for real size, and the book exists
    // precisely to stop assuming size is free — so those are not candidates.
    .where(ne(paperTrades.track, "elite"))
    .orderBy(asc(paperTrades.openedAt))
    .all()
    .filter((t) => !alreadySeen.has(t.id) && t.depthLadderJson !== null && isEligible(t));

  let taken = 0;
  const skips: Record<string, number> = {};

  for (const t of candidates) {
    // Rebuild the book's state AS OF this signal, from entries taken so far.
    const held = db
      .select({
        openedAt: capitalBook.openedAt,
        closedAt: capitalBook.closedAt,
        realizedPnl: capitalBook.realizedPnl,
      })
      .from(capitalBook)
      .where(ne(capitalBook.status, "skipped"))
      .all();

    const concurrent = concurrentAt(held, t.openedAt);
    // Cash freed by everything that had already settled when this arrived.
    const bankedPnl = held
      .filter((h) => h.closedAt !== null && h.closedAt <= t.openedAt && h.realizedPnl !== null)
      .reduce((s, h) => s + (h.realizedPnl ?? 0), 0);
    const freeCapital = CAPITAL_START + bankedPnl - concurrent * FLAT_STAKE;

    const verdict = decide({ freeCapital, concurrent, depthLadderJson: t.depthLadderJson });
    const common = {
      id: newId(),
      paperTradeId: t.id,
      sourceTrack: t.track,
      marketId: t.marketId,
      marketQuestion: t.marketQuestion,
      outcome: t.outcome,
      category: categorizeMarket(t.marketQuestion),
      armEntryPrice: t.entryPrice,
      stake: FLAT_STAKE,
      openedAt: t.openedAt,
    };

    if (!verdict.take) {
      db.insert(capitalBook)
        .values({ ...common, status: "skipped", skipReason: verdict.reason, closedAt: t.openedAt })
        .run();
      skips[verdict.reason] = (skips[verdict.reason] ?? 0) + 1;
      continue;
    }

    db.insert(capitalBook)
      .values({
        ...common,
        entryPrice: verdict.price,
        slippageCents: verdict.slippageCents,
        shares: FLAT_STAKE / verdict.price,
        status: "open",
      })
      .run();
    taken += 1;
  }

  // ---- 3. Recompute the capital curve over settled entries ---------------
  // Done as a pass rather than incrementally so a late settlement can never
  // leave the curve stitched in the wrong order.
  const chronological = db
    .select()
    .from(capitalBook)
    .where(ne(capitalBook.status, "skipped"))
    .orderBy(asc(capitalBook.closedAt))
    .all()
    .filter((e) => e.realizedPnl !== null && e.closedAt !== null);
  let capital = CAPITAL_START;
  for (const e of chronological) {
    capital += e.realizedPnl ?? 0;
    db.update(capitalBook).set({ capitalAfter: capital }).where(eq(capitalBook.id, e.id)).run();
  }

  const skipText = Object.entries(skips).map(([r, n]) => `${n} ${r}`).join(", ") || "0";
  log.info(
    `capital book: +${taken} tomados, ${settled} liquidados, saltados (${skipText}) — ` +
      `capital $${capital.toFixed(2)} (regla: $${FLAT_STAKE} plano, máx ${MAX_CONCURRENT} simultáneos)`,
  );
});
