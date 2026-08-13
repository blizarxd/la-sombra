import { and, gte, inArray, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";

/**
 * TEMPORARY debug export for an offline capital simulation. Returns settled
 * paper trades (non-elite arms, esports/cripto category, 55-59c entry band)
 * WITH open/close/resolve timestamps so a concurrency-aware simulation can be
 * run outside the app. Not linked from any UI page. Safe to delete once the
 * simulation is done — read-only, no side effects.
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      id: schema.paperTrades.id,
      track: schema.paperTrades.track,
      marketQuestion: schema.paperTrades.marketQuestion,
      entryPrice: schema.paperTrades.entryPrice,
      realizedPnl: schema.paperTrades.realizedPnl,
      simulatedPositionSize: schema.paperTrades.simulatedPositionSize,
      status: schema.paperTrades.status,
      openedAt: schema.paperTrades.openedAt,
      closedAt: schema.paperTrades.closedAt,
      resolvedAt: schema.paperTrades.resolvedAt,
    })
    .from(schema.paperTrades)
    .where(
      and(
        inArray(schema.paperTrades.track, ["core", "live", "trade", "crypto"]),
        inArray(schema.paperTrades.status, ["closed", "resolved"]),
        gte(schema.paperTrades.entryPrice, 0.55),
        lt(schema.paperTrades.entryPrice, 0.6),
      ),
    )
    .all();

  const filtered = rows
    .map((r) => ({ ...r, category: categorizeMarket(r.marketQuestion) }))
    .filter((r) => r.category === "esports" || r.category === "cripto");

  return Response.json({ count: filtered.length, rows: filtered });
}
