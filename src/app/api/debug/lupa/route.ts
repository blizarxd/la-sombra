import { getDb } from "@/db/client";
import { getSliceMatrices } from "@/lib/queries";

/**
 * TEMPORARY analysis dump: every matrix cell with its multiplicity-corrected
 * lower bound, so "what is actually well-measured" can be answered from
 * strictLcb instead of raw ROI. The matrix UI already computes these; this just
 * flattens and ranks them across all 13 tables at once. Read-only, no side
 * effects, not linked from any page. Delete once answered.
 */
export async function GET() {
  const db = getDb();
  const matrices = getSliceMatrices(db);

  type Flat = {
    matrix: string;
    row: string;
    col: string;
    n: number;
    roiPct: number;
    winRate: number;
    lcbPct: number | null;
    strictLcbPct: number | null;
    pnl: number;
    avgHoldHours: number | null;
    roiPerDayPct: number | null;
  };

  const flat: Flat[] = [];
  for (const m of matrices) {
    for (const r of m.rows) {
      for (const c of m.cols) {
        const cell = r.cells[c.key];
        if (!cell) continue;
        flat.push({
          matrix: m.title,
          row: r.label,
          col: c.label,
          n: cell.count,
          roiPct: 100 * cell.roi,
          winRate: cell.winRate,
          lcbPct: cell.lcb === null ? null : 100 * cell.lcb,
          strictLcbPct: cell.strictLcb === null ? null : 100 * cell.strictLcb,
          pnl: Math.round(cell.pnl * 100) / 100,
          avgHoldHours: cell.avgHoldHours,
          roiPerDayPct: cell.roiPerDay === null ? null : 100 * cell.roiPerDay,
        });
      }
    }
  }

  const totalCells = flat.length;
  const survivors = flat
    .filter((f) => f.strictLcbPct !== null && f.strictLcbPct > 0)
    .sort((a, b) => (b.strictLcbPct ?? 0) - (a.strictLcbPct ?? 0));
  const softSurvivors = flat
    .filter((f) => f.lcbPct !== null && f.lcbPct > 0)
    .sort((a, b) => (b.lcbPct ?? 0) - (a.lcbPct ?? 0));
  const worst = flat
    .filter((f) => f.strictLcbPct !== null)
    .sort((a, b) => (a.strictLcbPct ?? 0) - (b.strictLcbPct ?? 0))
    .slice(0, 12);

  return Response.json({
    totalCells,
    survivorsStrict: survivors.length,
    survivorsSoft: softSurvivors.length,
    matrices: matrices.map((m) => ({ title: m.title, rows: m.rows.length, cols: m.cols.length })),
    strictSurvivors: survivors.slice(0, 30),
    softOnly: softSurvivors.filter((s) => !(s.strictLcbPct !== null && s.strictLcbPct > 0)).slice(0, 25),
    worstCells: worst,
  });
}
