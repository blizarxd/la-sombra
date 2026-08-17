import { eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { edgeStats } from "@/lib/stats";

/**
 * TEMPORARY end-of-day cut: applies the SAME statistical lens to the live
 * forward-tests that was applied to the historical matrix. After one day the
 * question is not "is it green" but "is the green distinguishable from a good
 * run" — so this reports the lower confidence bound, not just the mean.
 *
 * Only 3 books are compared here (2 capital variants + exit), so the
 * multiplicity correction is small; the point is the sample-size penalty.
 * Read-only, no side effects. Delete once read.
 */
export async function GET() {
  const db = getDb();

  const summarize = (rois: number[], label: string) => {
    const s = edgeStats(rois, 3); // 3 competing books, not 400 cells
    return {
      label,
      n: s.n,
      roiPct: 100 * s.roi,
      winRatePct: 100 * s.winRate,
      lcbPct: s.lcb === null ? null : 100 * s.lcb,
      strictLcbPct: s.strictLcb === null ? null : 100 * s.strictLcb,
      winRateLcbPct: s.winRateLcb === null ? null : 100 * s.winRateLcb,
    };
  };

  const out: unknown[] = [];

  for (const variant of ["c3", "c5"]) {
    const rows = db
      .select()
      .from(schema.capitalBook)
      .where(eq(schema.capitalBook.variant, variant))
      .all()
      .filter((r) => r.realizedPnl !== null && r.status !== "skipped");
    out.push(summarize(rows.map((r) => (r.realizedPnl ?? 0) / r.stake), `capital ${variant}`));
  }

  const exitRows = db
    .select()
    .from(schema.exitBook)
    .where(ne(schema.exitBook.status, "skipped"))
    .all()
    .filter((r) => r.realizedPnl !== null);
  out.push(summarize(exitRows.map((r) => (r.realizedPnl ?? 0) / r.stake), "salidas (todas)"));

  // Per exit door — the diagnostic that decides whether the discipline works.
  const byDoor = new Map<string, number[]>();
  for (const r of exitRows) {
    const k = r.exitReason ?? "desconocido";
    const list = byDoor.get(k) ?? [];
    list.push((r.realizedPnl ?? 0) / r.stake);
    byDoor.set(k, list);
  }
  for (const [door, rois] of byDoor) out.push(summarize(rois, `  puerta: ${door}`));

  // Day-by-day so a single bad/good stretch is visible rather than averaged away.
  const dayAgg = new Map<string, { n: number; pnl: number }>();
  for (const r of exitRows) {
    if (!r.closedAt) continue;
    const k = r.closedAt.toISOString().slice(0, 10);
    const acc = dayAgg.get(k) ?? { n: 0, pnl: 0 };
    acc.n += 1;
    acc.pnl += r.realizedPnl ?? 0;
    dayAgg.set(k, acc);
  }

  return Response.json({
    books: out,
    exitByDay: [...dayAgg.entries()].sort().map(([day, v]) => ({ day, n: v.n, pnl: Math.round(v.pnl * 100) / 100 })),
  });
}
