import { desc, isNotNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";
import { isEligible } from "@/lib/fastBook";

/**
 * TEMPORARY debug export: distribution of expectedResolutionHours among
 * recently-opened non-elite copies, to check whether /rapidas is empty
 * because no signals qualify or because of a wiring bug. Read-only, no side
 * effects, not linked from any page. Delete once the question is answered.
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      marketQuestion: schema.paperTrades.marketQuestion,
      track: schema.paperTrades.track,
      expectedResolutionHours: schema.paperTrades.expectedResolutionHours,
      openedAt: schema.paperTrades.openedAt,
      depthLadderJson: schema.paperTrades.depthLadderJson,
    })
    .from(schema.paperTrades)
    .where(ne(schema.paperTrades.track, "elite"))
    .orderBy(desc(schema.paperTrades.openedAt))
    .limit(300)
    .all();

  const withErh = rows.filter((r) => r.expectedResolutionHours !== null);
  const withLadder = rows.filter((r) => r.depthLadderJson !== null);
  const eligible = rows.filter((r) => r.depthLadderJson !== null && isEligible(r as never));

  return Response.json({
    total: rows.length,
    withExpectedResolutionHours: withErh.length,
    withDepthLadder: withLadder.length,
    eligibleCount: eligible.length,
    sample: rows.slice(0, 40).map((r) => ({
      q: (r.marketQuestion ?? "").slice(0, 60),
      track: r.track,
      category: categorizeMarket(r.marketQuestion),
      erh: r.expectedResolutionHours,
      openedAt: r.openedAt,
      hasLadder: r.depthLadderJson !== null,
    })),
  });
}
