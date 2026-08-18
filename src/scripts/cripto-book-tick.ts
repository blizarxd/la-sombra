import { asc, eq, inArray, ne, sql } from "drizzle-orm";
import { criptoBook, paperTrades } from "@/db/schema";
import {
  BOOK_START_MS,
  CAPITAL_START,
  FLAT_STAKE,
  MAX_CONCURRENT,
  concurrentAt,
  decide,
  isDecided,
  isEligible,
  positionKey,
  realExitValue,
  type ExitDoor,
} from "@/lib/criptoBook";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * ₿ CRIPTO BOOK tick — see criptoBook.ts for the thesis.
 *
 * The one thing it does that no earlier book did: it prices the EXIT by
 * walking the recorded bid side for the position's real share count. When no
 * sell-side snapshot exists it refuses to close rather than fall back to the
 * touch price, because that fallback is exactly the flattering assumption the
 * whole exercise is meant to remove. A position stuck that way stays open and
 * is reported, not quietly settled at a price nobody could have got.
 *
 * SAFETY: paper only. Reads simulated copies, writes simulated bookkeeping.
 */

runScript("cripto-book-tick", async (db) => {
  const now = new Date();
  const doors: Record<string, number> = {};
  let settled = 0;
  let unpriceable = 0;

  const sweep = () => {
    const open = db.select().from(criptoBook).where(eq(criptoBook.status, "open")).all();
    if (!open.length) return;
    const under = db
      .select()
      .from(paperTrades)
      .where(inArray(paperTrades.id, open.map((e) => e.paperTradeId)))
      .all();
    const byId = new Map(under.map((t) => [t.id, t]));

    for (const entry of open) {
      const t = byId.get(entry.paperTradeId);
      if (!t || entry.entryPrice === null || entry.shares === null) continue;

      const heldHours = (now.getTime() - entry.openedAt.getTime()) / 3_600_000;
      // No time stop: the capital book where the +35.5% was measured has none,
      // and these markets resolve in ~15 minutes anyway, so waiting for the
      // oracle ties up no meaningful capital.
      let door: ExitDoor | null = null;
      if (t.status === "closed") door = "salida-billetera";
      else if (t.status === "resolved") door = "resolucion";
      else if (isDecided(t.currentPrice)) door = "precio-decidido";
      if (!door) continue;

      // A resolved market pays out per share with no book to sell into.
      if (door === "resolucion") {
        const won = (t.currentPrice ?? 0) >= 0.5;
        const proceeds = won ? entry.shares : 0;
        db.update(criptoBook)
          .set({
            status: "resolved",
            exitReason: door,
            exitPrice: won ? 1 : 0,
            realizedPnl: proceeds - entry.stake,
            heldHours,
            closedAt: t.resolvedAt ?? now,
          })
          .where(eq(criptoBook.id, entry.id))
          .run();
        doors[door] = (doors[door] ?? 0) + 1;
        settled += 1;
        continue;
      }

      // Everything else means selling into the book — price it for real.
      const proceeds = realExitValue(t.bidLevelsJson, entry.shares);
      if (proceeds === null) {
        unpriceable += 1;
        continue; // stay open rather than invent a fill
      }
      const achieved = proceeds / entry.shares;
      const touch = t.currentPrice;
      db.update(criptoBook)
        .set({
          status: "closed",
          exitReason: door,
          exitPrice: achieved,
          exitSlippageCents: touch === null ? null : (touch - achieved) * 100,
          realizedPnl: proceeds - entry.stake,
          heldHours,
          closedAt: now,
        })
        .where(eq(criptoBook.id, entry.id))
        .run();
      doors[door] = (doors[door] ?? 0) + 1;
      settled += 1;
    }
  };

  sweep();

  // ---- take new signals, oldest first ------------------------------------
  const seen = new Set(
    db.select({ paperTradeId: criptoBook.paperTradeId }).from(criptoBook).all().map((r) => r.paperTradeId),
  );
  const candidates = db
    .select()
    .from(paperTrades)
    .where(ne(paperTrades.track, "elite"))
    .orderBy(asc(paperTrades.openedAt))
    .all()
    .filter(
      (t) =>
        !seen.has(t.id) &&
        // Forward-only: never reach back into the data the thesis came from.
        t.openedAt.getTime() >= BOOK_START_MS &&
        t.depthLadderJson !== null &&
        isEligible(t),
    );

  let taken = 0;
  let confluences = 0;
  const skips: Record<string, number> = {};

  for (const t of candidates) {
    const held = db
      .select({
        id: criptoBook.id,
        marketId: criptoBook.marketId,
        outcome: criptoBook.outcome,
        openedAt: criptoBook.openedAt,
        closedAt: criptoBook.closedAt,
        realizedPnl: criptoBook.realizedPnl,
      })
      .from(criptoBook)
      .where(ne(criptoBook.status, "skipped"))
      .all();

    const concurrent = concurrentAt(held, t.openedAt);
    const banked = held
      .filter((h) => h.closedAt !== null && h.closedAt <= t.openedAt && h.realizedPnl !== null)
      .reduce((s, h) => s + (h.realizedPnl ?? 0), 0);
    const freeCapital = CAPITAL_START + banked - concurrent * FLAT_STAKE;

    const key = positionKey(t.marketId, t.outcome);
    const dup = held.find(
      (h) =>
        positionKey(h.marketId, h.outcome) === key &&
        h.openedAt <= t.openedAt &&
        (h.closedAt === null || h.closedAt > t.openedAt),
    );

    const verdict = decide({
      freeCapital,
      concurrent,
      depthLadderJson: t.depthLadderJson,
      alreadyHeld: Boolean(dup),
      maxConcurrent: MAX_CONCURRENT,
    });

    const common = {
      id: newId(),
      paperTradeId: t.id,
      sourceTrack: t.track,
      marketId: t.marketId,
      marketQuestion: t.marketQuestion,
      outcome: t.outcome,
      walletAddress: t.walletAddress,
      armEntryPrice: t.entryPrice,
      stake: FLAT_STAKE,
      openedAt: t.openedAt,
    };

    if (!verdict.take) {
      db.insert(criptoBook)
        .values({ ...common, status: "skipped", skipReason: verdict.reason, closedAt: t.openedAt })
        .run();
      skips[verdict.reason] = (skips[verdict.reason] ?? 0) + 1;
      if (dup) {
        db.update(criptoBook)
          .set({ armConfluence: sql`${criptoBook.armConfluence} + 1` })
          .where(eq(criptoBook.id, dup.id))
          .run();
        confluences += 1;
      }
      continue;
    }

    db.insert(criptoBook)
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

  // Anything just taken whose arm already settled should not sit open for a
  // whole tick, inflating its recorded holding time.
  sweep();

  // ---- recompute the capital curve ---------------------------------------
  const chronological = db
    .select()
    .from(criptoBook)
    .where(ne(criptoBook.status, "skipped"))
    .orderBy(asc(criptoBook.closedAt))
    .all()
    .filter((e) => e.realizedPnl !== null && e.closedAt !== null);
  let capital = CAPITAL_START;
  for (const e of chronological) {
    capital += e.realizedPnl ?? 0;
    db.update(criptoBook).set({ capitalAfter: capital }).where(eq(criptoBook.id, e.id)).run();
  }

  const doorText = Object.entries(doors).map(([d, n]) => `${n} ${d}`).join(", ") || "0";
  const skipText = Object.entries(skips).map(([r, n]) => `${n} ${r}`).join(", ") || "0";
  log.info(
    `cripto book: +${taken} tomados, ${settled} cerrados (${doorText}), ` +
      `${unpriceable} sin precio de salida (siguen abiertos), saltados (${skipText}), ` +
      `${confluences} confluencias — capital $${capital.toFixed(2)}`,
  );
});
