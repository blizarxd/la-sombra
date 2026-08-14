import { ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";
import { edgeStats } from "@/lib/stats";

/**
 * TEMPORARY: does the ONE matrix cell that survived multiplicity correction
 * (Esports, <1h settle, strictLcb +6.2%, n≈402) actually come from wallet-exit
 * discipline, or from genuine market speed? Splits that exact cell by HOW it
 * settled (arm status "closed" = wallet exit followed, vs "resolved" = held to
 * oracle) and reports edgeStats (incl. strictLcb) for each half. If the
 * closed-half explains nearly all the positive floor, the two "findings" are
 * one mechanism, not two. Read-only, no side effects. Delete once answered.
 */
export async function GET() {
  const db = getDb();
  const trades = db
    .select({
      status: schema.paperTrades.status,
      marketQuestion: schema.paperTrades.marketQuestion,
      entryPrice: schema.paperTrades.entryPrice,
      simulatedPositionSize: schema.paperTrades.simulatedPositionSize,
      realizedPnl: schema.paperTrades.realizedPnl,
      openedAt: schema.paperTrades.openedAt,
      closedAt: schema.paperTrades.closedAt,
      resolvedAt: schema.paperTrades.resolvedAt,
    })
    .from(schema.paperTrades)
    .where(ne(schema.paperTrades.track, "elite"))
    .all()
    .filter((t) => t.status !== "open" && t.realizedPnl !== null);

  const esportsUnder1h = trades.filter((t) => {
    if (categorizeMarket(t.marketQuestion) !== "esports") return false;
    const end = t.resolvedAt ?? t.closedAt;
    if (!end) return false;
    const durH = (end.getTime() - t.openedAt.getTime()) / 3_600_000;
    return durH < 1;
  });

  const exitCopied = esportsUnder1h.filter((t) => t.status === "closed");
  const oracleResolved = esportsUnder1h.filter((t) => t.status === "resolved");

  const roiOf = (rows: typeof trades) => rows.map((t) => (t.realizedPnl ?? 0) / t.simulatedPositionSize);

  const cellsTested = 400; // matches the earlier lupa's total cell count
  const summarize = (rows: typeof trades) => {
    const stats = edgeStats(roiOf(rows), cellsTested);
    return {
      n: stats.n,
      roiPct: 100 * stats.roi,
      winRatePct: 100 * stats.winRate,
      lcbPct: stats.lcb === null ? null : 100 * stats.lcb,
      strictLcbPct: stats.strictLcb === null ? null : 100 * stats.strictLcb,
    };
  };

  return Response.json({
    wholeCell_esports_under1h: summarize(esportsUnder1h),
    half_exitCopied_walletSold: summarize(exitCopied),
    half_oracleResolved: summarize(oracleResolved),
  });
}
