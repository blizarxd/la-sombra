import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { capitalBook, paperTrades } from "@/db/schema";
import {
  CAPITAL_START,
  FLAT_STAKE,
  VARIANTS,
  armExitPrice,
  concurrentAt,
  decide,
  isDecided,
  isEligible,
  positionKey,
  settledPnl,
} from "@/lib/capitalBook";
import { categorizeMarket } from "@/lib/category";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * 💰 CAPITAL BOOK tick.
 *
 * Mirrors qualifying arm copies into simulated bankrolls under hard rules
 * (fixed capital, flat stake, max concurrent positions, one bet per market) and
 * settles them when the underlying copy settles.
 *
 * Runs every VARIANT over the SAME signal stream, so the only difference
 * between the books is the rule being tested.
 *
 * Two properties this depends on:
 *
 * 1. It processes new signals in openedAt ORDER and judges concurrency at each
 *    signal's own timestamp — not at tick time. So a signal that arrived while
 *    the book was full is skipped even if a slot has since freed. Running late
 *    must not make the book look luckier than it was.
 *
 * 2. It never re-decides a signal (unique index on variant + paper_trade_id).
 *    Once taken or skipped, that verdict stands.
 *
 * SAFETY: paper only. It reads existing simulated copies and writes simulated
 * bookkeeping. It places nothing.
 */

runScript("capital-book-tick", async (db) => {
  // ---- 1. Settle entries whose underlying copy has finished --------------
  const openEntries = db.select().from(capitalBook).where(eq(capitalBook.status, "open")).all();
  let settled = 0;
  let earlyExits = 0;
  if (openEntries.length) {
    const underlying = db
      .select()
      .from(paperTrades)
      .where(inArray(paperTrades.id, openEntries.map((e) => e.paperTradeId)))
      .all();
    const byId = new Map(underlying.map((t) => [t.id, t]));
    for (const entry of openEntries) {
      const t = byId.get(entry.paperTradeId);
      if (!t || entry.entryPrice === null) continue;

      if (t.status === "open") {
        // The arm holds to the oracle; we do not. Once the price leaves no real
        // doubt the position is just parked capital blocking a slot, and it can
        // be sold at the current bid — so book it at that bid and free the slot.
        if (!isDecided(t.currentPrice)) continue;
        db.update(capitalBook)
          .set({
            status: "closed",
            exitReason: "venta-anticipada",
            realizedPnl: settledPnl(entry.entryPrice, entry.stake, t.currentPrice as number),
            closedAt: new Date(),
          })
          .where(eq(capitalBook.id, entry.id))
          .run();
        earlyExits += 1;
        settled += 1;
        continue;
      }

      const exit = armExitPrice(t);
      if (exit === null) continue;
      db.update(capitalBook)
        .set({
          status: t.status === "resolved" ? "resolved" : "closed",
          exitReason: t.status === "resolved" ? "resolucion" : "salida-brazo",
          realizedPnl: settledPnl(entry.entryPrice, entry.stake, exit),
          closedAt: t.resolvedAt ?? t.closedAt ?? new Date(),
        })
        .where(eq(capitalBook.id, entry.id))
        .run();
      settled += 1;
    }
  }

  // ---- 2. Consider new signals per variant, oldest first ------------------
  const eligible = db
    .select()
    .from(paperTrades)
    // No ladder means no measured price for real size, and these books exist
    // precisely to stop assuming size is free — so those are not candidates.
    .where(ne(paperTrades.track, "elite"))
    .orderBy(asc(paperTrades.openedAt))
    .all()
    .filter((t) => t.depthLadderJson !== null && isEligible(t));

  for (const variant of VARIANTS) {
    const seen = new Set(
      db
        .select({ paperTradeId: capitalBook.paperTradeId })
        .from(capitalBook)
        .where(eq(capitalBook.variant, variant.id))
        .all()
        .map((r) => r.paperTradeId),
    );
    const candidates = eligible.filter((t) => !seen.has(t.id));
    let taken = 0;
    let confluences = 0;
    const skips: Record<string, number> = {};

    for (const t of candidates) {
      // Rebuild this book's state AS OF this signal.
      const held = db
        .select({
          id: capitalBook.id,
          marketId: capitalBook.marketId,
          outcome: capitalBook.outcome,
          openedAt: capitalBook.openedAt,
          closedAt: capitalBook.closedAt,
          realizedPnl: capitalBook.realizedPnl,
        })
        .from(capitalBook)
        .where(and(eq(capitalBook.variant, variant.id), ne(capitalBook.status, "skipped")))
        .all();

      const concurrent = concurrentAt(held, t.openedAt);
      const bankedPnl = held
        .filter((h) => h.closedAt !== null && h.closedAt <= t.openedAt && h.realizedPnl !== null)
        .reduce((s, h) => s + (h.realizedPnl ?? 0), 0);
      const freeCapital = CAPITAL_START + bankedPnl - concurrent * FLAT_STAKE;

      // Same bet already live in this book? Then this arm is agreement, not a
      // second position.
      const key = positionKey(t.marketId, t.outcome);
      const duplicateOf = held.find(
        (h) =>
          positionKey(h.marketId, h.outcome) === key &&
          h.openedAt <= t.openedAt &&
          (h.closedAt === null || h.closedAt > t.openedAt),
      );

      const verdict = decide({
        freeCapital,
        concurrent,
        depthLadderJson: t.depthLadderJson,
        alreadyHeld: Boolean(duplicateOf),
        maxConcurrent: variant.maxConcurrent,
      });

      const common = {
        id: newId(),
        variant: variant.id,
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
        // Agreement adds no stake, but whether it predicts a better result is
        // worth knowing — so it is counted on the position actually held.
        if (duplicateOf) {
          db.update(capitalBook)
            .set({ armConfluence: sql`${capitalBook.armConfluence} + 1` })
            .where(eq(capitalBook.id, duplicateOf.id))
            .run();
          confluences += 1;
        }
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

    // ---- 3. Recompute this book's capital curve ---------------------------
    // A full pass rather than an incremental add, so a late settlement can
    // never leave the curve stitched in the wrong order.
    const chronological = db
      .select()
      .from(capitalBook)
      .where(and(eq(capitalBook.variant, variant.id), ne(capitalBook.status, "skipped")))
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
      `capital book [${variant.id}, máx ${variant.maxConcurrent}]: +${taken} tomados, ` +
        `saltados (${skipText}), ${confluences} confluencias — capital $${capital.toFixed(2)}`,
    );
  }

  log.info(`capital book: ${settled} liquidados en total (${earlyExits} por venta anticipada)`);
});
