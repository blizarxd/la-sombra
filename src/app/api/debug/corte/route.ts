import { eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { edgeStats } from "@/lib/stats";

/**
 * TEMPORARY detailed cut: every live forward-test book, with confidence bounds
 * rather than point estimates, plus the breakdowns that decide whether each
 * one is working — exit doors for the exit book, category and confluence for
 * the capital book, and a per-day series so a single stretch is visible
 * instead of averaged away.
 *
 * Read-only, no side effects. Delete once read.
 */
export async function GET() {
  const db = getDb();

  const stat = (rois: number[], label: string) => {
    const s = edgeStats(rois, 3);
    return {
      label,
      n: s.n,
      roiPct: 100 * s.roi,
      winRatePct: 100 * s.winRate,
      lcbPct: s.lcb === null ? null : 100 * s.lcb,
      winRateLcbPct: s.winRateLcb === null ? null : 100 * s.winRateLcb,
    };
  };

  // ---- capital book, per variant + breakdowns ----
  const capital: unknown[] = [];
  const capitalDetail: Record<string, unknown> = {};
  for (const variant of ["c3", "c5"]) {
    const all = db.select().from(schema.capitalBook).where(eq(schema.capitalBook.variant, variant)).all();
    const settled = all.filter((r) => r.realizedPnl !== null && r.status !== "skipped");
    capital.push(stat(settled.map((r) => (r.realizedPnl ?? 0) / r.stake), `capital ${variant}`));

    if (variant === "c5") {
      const byCat = new Map<string, number[]>();
      for (const r of settled) {
        const k = r.category ?? "otros";
        (byCat.get(k) ?? byCat.set(k, []).get(k)!).push((r.realizedPnl ?? 0) / r.stake);
      }
      capitalDetail.porCategoria = [...byCat.entries()].map(([k, v]) => stat(v, k));

      const conf = settled.filter((r) => r.armConfluence > 1).map((r) => (r.realizedPnl ?? 0) / r.stake);
      const solo = settled.filter((r) => r.armConfluence <= 1).map((r) => (r.realizedPnl ?? 0) / r.stake);
      capitalDetail.confluencia = [stat(conf, "2+ brazos"), stat(solo, "1 brazo")];

      const byExit = new Map<string, number[]>();
      for (const r of settled) {
        const k = r.exitReason ?? "desconocido";
        (byExit.get(k) ?? byExit.set(k, []).get(k)!).push((r.realizedPnl ?? 0) / r.stake);
      }
      capitalDetail.porSalida = [...byExit.entries()].map(([k, v]) => stat(v, k));

      const byDay = new Map<string, { n: number; pnl: number }>();
      for (const r of settled) {
        if (!r.closedAt) continue;
        const k = r.closedAt.toISOString().slice(0, 10);
        const acc = byDay.get(k) ?? { n: 0, pnl: 0 };
        acc.n += 1;
        acc.pnl += r.realizedPnl ?? 0;
        byDay.set(k, acc);
      }
      capitalDetail.porDia = [...byDay.entries()].sort().map(([d, v]) => ({ day: d, n: v.n, pnl: Math.round(v.pnl * 100) / 100 }));

      capitalDetail.embudo = {
        vistas: all.length,
        tomadas: all.filter((r) => r.status !== "skipped").length,
        saltadas: all.filter((r) => r.status === "skipped").length,
        abiertas: all.filter((r) => r.status === "open").length,
      };
    }
  }

  // ---- exit book ----
  const exitAll = db.select().from(schema.exitBook).all();
  const exitSettled = exitAll.filter((r) => r.realizedPnl !== null && r.status !== "skipped");
  const exitDoors = new Map<string, number[]>();
  for (const r of exitSettled) {
    const k = r.exitReason ?? "desconocido";
    (exitDoors.get(k) ?? exitDoors.set(k, []).get(k)!).push((r.realizedPnl ?? 0) / r.stake);
  }
  const exitByDay = new Map<string, { n: number; pnl: number }>();
  for (const r of exitSettled) {
    if (!r.closedAt) continue;
    const k = r.closedAt.toISOString().slice(0, 10);
    const acc = exitByDay.get(k) ?? { n: 0, pnl: 0 };
    acc.n += 1;
    acc.pnl += r.realizedPnl ?? 0;
    exitByDay.set(k, acc);
  }

  // ---- fast book (paused) final state ----
  const fastAll = db.select().from(schema.fastBook).all();
  const fastSettled = fastAll.filter((r) => r.realizedPnl !== null && r.status !== "skipped");

  return Response.json({
    capital,
    capitalDetail,
    exit: {
      overall: stat(exitSettled.map((r) => (r.realizedPnl ?? 0) / r.stake), "salidas total"),
      puertas: [...exitDoors.entries()].map(([k, v]) => stat(v, k)),
      porDia: [...exitByDay.entries()].sort().map(([d, v]) => ({ day: d, n: v.n, pnl: Math.round(v.pnl * 100) / 100 })),
      abiertas: exitAll.filter((r) => r.status === "open").length,
    },
    fastPaused: stat(fastSettled.map((r) => (r.realizedPnl ?? 0) / r.stake), "rapidas (pausado)"),
  });
}
