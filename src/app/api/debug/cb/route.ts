import { inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { isEligible } from "@/lib/capitalBook";

/**
 * TEMPORARY debug export: capital-book state plus how long the underlying arm
 * copies actually take to settle, to test whether the concurrency cap or the
 * hold time is what starves the book. Read-only, no side effects, not linked
 * from any page. Delete once the question is answered.
 */
export async function GET() {
  const db = getDb();

  const book = db.select().from(schema.capitalBook).all();
  const ids = book.map((b) => b.paperTradeId);
  const trades = ids.length
    ? db.select().from(schema.paperTrades).where(inArray(schema.paperTrades.id, ids)).all()
    : [];
  const byId = new Map(trades.map((t) => [t.id, t]));

  const rows = book.map((b) => {
    const t = byId.get(b.paperTradeId);
    return {
      variant: b.variant,
      status: b.status,
      skipReason: b.skipReason,
      question: b.marketQuestion,
      outcome: b.outcome,
      entryPrice: b.entryPrice,
      armEntryPrice: b.armEntryPrice,
      realizedPnl: b.realizedPnl,
      openedAt: b.openedAt,
      closedAt: b.closedAt,
      armStatus: t?.status ?? null,
      armCurrentPrice: t?.currentPrice ?? null,
      armResolvedAt: t?.resolvedAt ?? null,
      armClosedAt: t?.closedAt ?? null,
    };
  });

  // Every eligible copy, settled or not, to measure real hold duration.
  const all = db
    .select()
    .from(schema.paperTrades)
    .where(ne(schema.paperTrades.track, "elite"))
    .all()
    .filter((t) => t.depthLadderJson !== null && isEligible(t));

  const holds = all.map((t) => ({
    status: t.status,
    openedAt: t.openedAt,
    settledAt: t.resolvedAt ?? t.closedAt ?? null,
    currentPrice: t.currentPrice,
    entryPrice: t.entryPrice,
    question: t.marketQuestion,
  }));

  return Response.json({ bookCount: book.length, eligibleCount: all.length, rows, holds });
}
