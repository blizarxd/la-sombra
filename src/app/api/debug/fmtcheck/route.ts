import { inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";
import { isFastFormatMarket } from "@/lib/fastFormat";

/**
 * TEMPORARY: does the text-format classifier actually pick out fast,
 * profitable trades in the HISTORICAL record — or a different population than
 * the /matriz "<1h" cell that inspired it? Compares real settle duration and
 * ROI for format-matched vs the general esports/deportes population. Read-only,
 * no side effects, not linked from any page. Delete once answered.
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      marketQuestion: schema.paperTrades.marketQuestion,
      entryPrice: schema.paperTrades.entryPrice,
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
    .filter((r) => r.status !== "open" && r.realizedPnl !== null);

  type Bucket = { n: number; wins: number; staked: number; pnl: number; durSumH: number };
  const mk = (): Bucket => ({ n: 0, wins: 0, staked: 0, pnl: 0, durSumH: 0 });
  const add = (b: Bucket, r: (typeof rows)[number], durH: number) => {
    b.n += 1;
    if ((r.realizedPnl ?? 0) > 0) b.wins += 1;
    b.staked += r.simulatedPositionSize;
    b.pnl += r.realizedPnl ?? 0;
    b.durSumH += durH;
  };
  const summarize = (b: Bucket) => ({
    n: b.n,
    winRate: b.n ? b.wins / b.n : null,
    roiPct: b.staked ? (100 * b.pnl) / b.staked : null,
    pnl: Math.round(b.pnl * 100) / 100,
    avgDurationHours: b.n ? b.durSumH / b.n : null,
  });

  const esportsDeportesAll = mk();
  const esportsDeportesUnder1h = mk(); // original finding: actual settle time <1h
  const formatMatched = mk(); // new proxy: text says fast format
  const formatMatchedAndUnder1h = mk(); // overlap
  const formatMatchedButSlow = mk(); // proxy said fast, actually took >1h
  const notFormatMatchedButFast = mk(); // actual <1h but proxy didn't catch it

  for (const r of rows) {
    const cat = categorizeMarket(r.marketQuestion);
    if (cat !== "esports" && cat !== "deportes") continue;
    const end = r.resolvedAt ?? r.closedAt;
    if (!end) continue;
    const durH = (end.getTime() - r.openedAt.getTime()) / 3_600_000;
    const fmt = isFastFormatMarket(r.marketQuestion);

    add(esportsDeportesAll, r, durH);
    if (durH < 1) add(esportsDeportesUnder1h, r, durH);
    if (fmt) add(formatMatched, r, durH);
    if (fmt && durH < 1) add(formatMatchedAndUnder1h, r, durH);
    if (fmt && durH >= 1) add(formatMatchedButSlow, r, durH);
    if (!fmt && durH < 1) add(notFormatMatchedButFast, r, durH);
  }

  return Response.json({
    esportsDeportesAll: summarize(esportsDeportesAll),
    esportsDeportesUnder1h_ORIGINAL_FINDING: summarize(esportsDeportesUnder1h),
    formatMatched_NEW_PROXY: summarize(formatMatched),
    overlap_formatMatchedAndUnder1h: summarize(formatMatchedAndUnder1h),
    formatMatchedButActuallySlow: summarize(formatMatchedButSlow),
    fastButProxyMissedIt: summarize(notFormatMatchedButFast),
  });
}
