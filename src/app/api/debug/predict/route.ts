import { ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";

/**
 * TEMPORARY research dump, second pass.
 *
 * No entry-time signal predicted fast settlement (best combination: 18% of
 * esports in-play trades settled under an hour, and even that group lost
 * money). That failure points at the definition itself: a paper trade settles
 * either because the MARKET RESOLVED or because the copied wallet SOLD and we
 * followed it out. Those are completely different events. If the profitable
 * "<1h" cell is mostly the second kind, then the finding was never about fast
 * markets at all — it is about fast EXITS, which is a property of the wallet's
 * behaviour, not of the market's schedule.
 *
 * Read-only, no side effects, not linked from any page. Delete once answered.
 */
export async function GET() {
  const db = getDb();

  const trades = db
    .select({
      track: schema.paperTrades.track,
      marketQuestion: schema.paperTrades.marketQuestion,
      simulatedPositionSize: schema.paperTrades.simulatedPositionSize,
      realizedPnl: schema.paperTrades.realizedPnl,
      status: schema.paperTrades.status,
      openedAt: schema.paperTrades.openedAt,
      closedAt: schema.paperTrades.closedAt,
      resolvedAt: schema.paperTrades.resolvedAt,
    })
    .from(schema.paperTrades)
    .where(ne(schema.paperTrades.track, "elite"))
    .all()
    .filter((t) => t.status !== "open" && t.realizedPnl !== null);

  type B = { n: number; wins: number; staked: number; pnl: number; durSum: number };
  const mk = (): B => ({ n: 0, wins: 0, staked: 0, pnl: 0, durSum: 0 });
  const buckets = new Map<string, B>();
  const add = (k: string, durH: number, t: (typeof trades)[number]) => {
    const b = buckets.get(k) ?? mk();
    b.n += 1;
    if ((t.realizedPnl ?? 0) > 0) b.wins += 1;
    b.staked += t.simulatedPositionSize;
    b.pnl += t.realizedPnl ?? 0;
    b.durSum += durH;
    buckets.set(k, b);
  };

  for (const t of trades) {
    const end = t.resolvedAt ?? t.closedAt;
    if (!end) continue;
    const durH = (end.getTime() - t.openedAt.getTime()) / 3_600_000;
    const cat = categorizeMarket(t.marketQuestion);
    // "resolved" = held to the oracle. "exit-copied" = the wallet sold and we
    // followed. Only the first is a statement about the market's speed.
    const how = t.status === "resolved" ? "RESUELTO (oraculo)" : "SALIDA-COPIADA (billetera vendio)";
    const speed = durH < 1 ? "<1h" : ">=1h";

    add(`${speed} | ${how}`, durH, t);
    if (cat === "esports") add(`ESPORTS ${speed} | ${how}`, durH, t);
    if (durH < 1) add(`<1h por brazo: ${t.track}`, durH, t);
    if (durH < 1 && cat === "esports") add(`ESPORTS <1h por brazo: ${t.track}`, durH, t);
  }

  const out = [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      n: b.n,
      avgDurationH: b.n ? b.durSum / b.n : 0,
      winRate: b.n ? b.wins / b.n : 0,
      roiPct: b.staked ? (100 * b.pnl) / b.staked : 0,
      pnl: Math.round(b.pnl * 100) / 100,
    }))
    .filter((r) => r.n >= 10)
    .sort((a, b) => b.roiPct - a.roiPct);

  return Response.json({ considered: trades.length, buckets: out });
}
