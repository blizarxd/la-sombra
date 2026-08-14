import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { fastBook, paperTrades } from "@/db/schema";
import {
  CAPITAL_START,
  FLAT_STAKE,
  MAX_CONCURRENT,
  armExitPrice,
  concurrentAt,
  decide,
  isDecided,
  isEligible,
  positionKey,
  settledPnl,
} from "@/lib/fastBook";
import { categorizeMarket } from "@/lib/category";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * ⚡ FAST BOOK tick — forward-test of the duration finding (see fastBook.ts).
 *
 * Same mechanics as capital-book-tick.ts (settle → sell-if-decided → take new
 * signals in order → recompute the curve), applied to the duration-based
 * eligibility instead of the price-band one. One book, no A/B variant: the
 * whole premise here is that fast turnover should rarely hit the cap at all,
 * so there is nothing to compare yet — if MAX_CONCURRENT does start binding,
 * that itself is the finding worth splitting into variants.
 *
 * SAFETY: paper only. Reads existing simulated copies, writes simulated
 * bookkeeping. Places nothing.
 */

runScript("fast-book-tick", async (db) => {
  const openEntries = db.select().from(fastBook).where(eq(fastBook.status, "open")).all();
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
        if (!isDecided(t.currentPrice)) continue;
        db.update(fastBook)
          .set({
            status: "closed",
            exitReason: "venta-anticipada",
            realizedPnl: settledPnl(entry.entryPrice, entry.stake, t.currentPrice as number),
            closedAt: new Date(),
          })
          .where(eq(fastBook.id, entry.id))
          .run();
        earlyExits += 1;
        settled += 1;
        continue;
      }

      const exit = armExitPrice(t);
      if (exit === null) continue;
      db.update(fastBook)
        .set({
          status: t.status === "resolved" ? "resolved" : "closed",
          exitReason: t.status === "resolved" ? "resolucion" : "salida-brazo",
          realizedPnl: settledPnl(entry.entryPrice, entry.stake, exit),
          closedAt: t.resolvedAt ?? t.closedAt ?? new Date(),
        })
        .where(eq(fastBook.id, entry.id))
        .run();
      settled += 1;
    }
  }

  const seen = new Set(
    db.select({ paperTradeId: fastBook.paperTradeId }).from(fastBook).all().map((r) => r.paperTradeId),
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
        id: fastBook.id,
        marketId: fastBook.marketId,
        outcome: fastBook.outcome,
        openedAt: fastBook.openedAt,
        closedAt: fastBook.closedAt,
        realizedPnl: fastBook.realizedPnl,
      })
      .from(fastBook)
      .where(ne(fastBook.status, "skipped"))
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
      category: categorizeMarket(t.marketQuestion),
      expectedResolutionHours: t.expectedResolutionHours,
      armEntryPrice: t.entryPrice,
      stake: FLAT_STAKE,
      openedAt: t.openedAt,
    };

    if (!verdict.take) {
      db.insert(fastBook)
        .values({ ...common, status: "skipped", skipReason: verdict.reason, closedAt: t.openedAt })
        .run();
      skips[verdict.reason] = (skips[verdict.reason] ?? 0) + 1;
      if (duplicateOf) {
        db.update(fastBook)
          .set({ armConfluence: sql`${fastBook.armConfluence} + 1` })
          .where(eq(fastBook.id, duplicateOf.id))
          .run();
        confluences += 1;
      }
      continue;
    }

    db.insert(fastBook)
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

  const chronological = db
    .select()
    .from(fastBook)
    .where(ne(fastBook.status, "skipped"))
    .orderBy(asc(fastBook.closedAt))
    .all()
    .filter((e) => e.realizedPnl !== null && e.closedAt !== null);
  let capital = CAPITAL_START;
  for (const e of chronological) {
    capital += e.realizedPnl ?? 0;
    db.update(fastBook).set({ capitalAfter: capital }).where(eq(fastBook.id, e.id)).run();
  }

  const skipText = Object.entries(skips).map(([r, n]) => `${n} ${r}`).join(", ") || "0";
  log.info(
    `fast book: +${taken} tomados, ${settled} liquidados (${earlyExits} venta anticipada), ` +
      `saltados (${skipText}), ${confluences} confluencias — capital $${capital.toFixed(2)}`,
  );
});
