import { asc, eq, inArray, ne, sql } from "drizzle-orm";
import { exitBook, paperTrades } from "@/db/schema";
import {
  CAPITAL_START,
  FLAT_STAKE,
  MAX_CONCURRENT,
  armExitPrice,
  categoryOf,
  concurrentAt,
  decide,
  decideExit,
  isEligible,
  positionKey,
  settledPnl,
} from "@/lib/exitBook";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * 🚪 EXIT BOOK tick — see exitBook.ts for the finding this tests.
 *
 * Differs from the other book ticks in ONE way that is the whole point: it
 * does not wait for the underlying arm trade to settle. It evaluates every
 * open position on each pass and takes it out through whichever door is open —
 * the wallet's sale, a decided price, or the time stop.
 *
 * SAFETY: paper only. Reads existing simulated copies, writes simulated
 * bookkeeping. Places nothing.
 */

runScript("exit-book-tick", async (db) => {
  const now = new Date();

  // ---- 1. Walk every open position and see if a door is open -------------
  const openEntries = db.select().from(exitBook).where(eq(exitBook.status, "open")).all();
  const doors: Record<string, number> = {};
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
      if (!t || entry.entryPrice === null) continue;

      const heldHours = (now.getTime() - entry.openedAt.getTime()) / 3_600_000;
      const verdict = decideExit({
        armStatus: t.status,
        armClosedAt: t.closedAt,
        armResolvedAt: t.resolvedAt,
        armExitPrice: armExitPrice(t),
        currentPrice: t.currentPrice,
        heldHours,
      });
      if (!verdict) continue;

      db.update(exitBook)
        .set({
          // "resolucion" means the discipline failed to get us out in time;
          // everything else is a deliberate exit.
          status: verdict.door === "resolucion" ? "resolved" : "closed",
          exitReason: verdict.door,
          realizedPnl: settledPnl(entry.entryPrice, entry.stake, verdict.price),
          heldHours,
          closedAt: now,
        })
        .where(eq(exitBook.id, entry.id))
        .run();
      doors[verdict.door] = (doors[verdict.door] ?? 0) + 1;
      settled += 1;
    }
  }

  // ---- 2. Take new signals, oldest first ---------------------------------
  const seen = new Set(
    db.select({ paperTradeId: exitBook.paperTradeId }).from(exitBook).all().map((r) => r.paperTradeId),
  );
  const candidates = db
    .select()
    .from(paperTrades)
    .where(ne(paperTrades.track, "elite"))
    .orderBy(asc(paperTrades.openedAt))
    .all()
    .filter((t) => !seen.has(t.id) && t.depthLadderJson !== null && isEligible(t));

  let taken = 0;
  let confluences = 0;
  const skips: Record<string, number> = {};

  for (const t of candidates) {
    const held = db
      .select({
        id: exitBook.id,
        marketId: exitBook.marketId,
        outcome: exitBook.outcome,
        openedAt: exitBook.openedAt,
        closedAt: exitBook.closedAt,
        realizedPnl: exitBook.realizedPnl,
      })
      .from(exitBook)
      .where(ne(exitBook.status, "skipped"))
      .all();

    const concurrent = concurrentAt(held, t.openedAt);
    const bankedPnl = held
      .filter((h) => h.closedAt !== null && h.closedAt <= t.openedAt && h.realizedPnl !== null)
      .reduce((s, h) => s + (h.realizedPnl ?? 0), 0);
    const freeCapital = CAPITAL_START + bankedPnl - concurrent * FLAT_STAKE;

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
      maxConcurrent: MAX_CONCURRENT,
    });

    const common = {
      id: newId(),
      paperTradeId: t.id,
      sourceTrack: t.track,
      marketId: t.marketId,
      marketQuestion: t.marketQuestion,
      outcome: t.outcome,
      category: categoryOf(t.marketQuestion),
      walletAddress: t.walletAddress,
      armEntryPrice: t.entryPrice,
      stake: FLAT_STAKE,
      openedAt: t.openedAt,
    };

    if (!verdict.take) {
      db.insert(exitBook)
        .values({ ...common, status: "skipped", skipReason: verdict.reason, closedAt: t.openedAt })
        .run();
      skips[verdict.reason] = (skips[verdict.reason] ?? 0) + 1;
      if (duplicateOf) {
        db.update(exitBook)
          .set({ armConfluence: sql`${exitBook.armConfluence} + 1` })
          .where(eq(exitBook.id, duplicateOf.id))
          .run();
        confluences += 1;
      }
      continue;
    }

    db.insert(exitBook)
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

  // ---- 2b. Immediately re-check anything just taken ----------------------
  // Step 1 only sees positions that existed BEFORE this pass, so a signal
  // whose arm trade had already settled would sit "open" until the next tick —
  // ~20 minutes of a position the book never actually held. Sweeping the new
  // entries here keeps recorded holding times honest rather than inflated by
  // our own scheduling.
  const freshlyOpen = db.select().from(exitBook).where(eq(exitBook.status, "open")).all();
  if (freshlyOpen.length) {
    const under = db
      .select()
      .from(paperTrades)
      .where(inArray(paperTrades.id, freshlyOpen.map((e) => e.paperTradeId)))
      .all();
    const byId2 = new Map(under.map((t) => [t.id, t]));
    for (const entry of freshlyOpen) {
      const t = byId2.get(entry.paperTradeId);
      if (!t || entry.entryPrice === null || t.status === "open") continue;
      const exitP = armExitPrice(t);
      if (exitP === null) continue;
      const heldHours = Math.max(
        0,
        ((t.resolvedAt ?? t.closedAt ?? now).getTime() - entry.openedAt.getTime()) / 3_600_000,
      );
      const door = t.status === "closed" ? "salida-billetera" : "resolucion";
      db.update(exitBook)
        .set({
          status: t.status === "closed" ? "closed" : "resolved",
          exitReason: door,
          realizedPnl: settledPnl(entry.entryPrice, entry.stake, exitP),
          heldHours,
          closedAt: t.resolvedAt ?? t.closedAt ?? now,
        })
        .where(eq(exitBook.id, entry.id))
        .run();
      doors[door] = (doors[door] ?? 0) + 1;
      settled += 1;
    }
  }

  // ---- 3. Recompute the capital curve ------------------------------------
  const chronological = db
    .select()
    .from(exitBook)
    .where(ne(exitBook.status, "skipped"))
    .orderBy(asc(exitBook.closedAt))
    .all()
    .filter((e) => e.realizedPnl !== null && e.closedAt !== null);
  let capital = CAPITAL_START;
  for (const e of chronological) {
    capital += e.realizedPnl ?? 0;
    db.update(exitBook).set({ capitalAfter: capital }).where(eq(exitBook.id, e.id)).run();
  }

  const doorText = Object.entries(doors).map(([d, n]) => `${n} ${d}`).join(", ") || "0";
  const skipText = Object.entries(skips).map(([r, n]) => `${n} ${r}`).join(", ") || "0";
  log.info(
    `exit book: +${taken} tomados, ${settled} cerrados por puerta (${doorText}), ` +
      `saltados (${skipText}), ${confluences} confluencias — capital $${capital.toFixed(2)}`,
  );
});
