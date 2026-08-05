import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { paperTrades } from "@/db/schema";
import { CATEGORY_LABELS, type CategoryKey } from "./category";
import { LATENCY_LABELS, bandOf, categoryOf, dragBy, latencyBucket, loadDragRows, summarizeDrag } from "./copyDrag";
import { CONFLUENCE_WINDOW_MS, findClusters, loadRecentForConfluence } from "./confluence";
import { attachPaths, loadPaths, studyExits } from "./exitStudy";
import { PRICE_BANDS } from "./slices";

/**
 * 🔬 The research pack — three questions the bot could always have answered from
 * data it was already storing, and never did:
 *
 *   · What does copying COST us before the bet is judged? (copyDrag)
 *   · How often do independent wallets agree, and does agreement pay? (confluence)
 *   · Would any exit rule have beaten holding to resolution? (exitStudy)
 *
 * Assembled here in one compact, model-readable shape so the daily cut reasons
 * over them instead of over PnL alone. Read-only; every loader degrades to an
 * empty result rather than throwing, so a missing table never breaks the cut.
 */

const bandLabel = new Map(PRICE_BANDS.map((b) => [b.key, b.label]));
const pct = (x: number | null) => (x === null ? "s/d" : `${(x * 100).toFixed(1)}%`);

export function researchSummary(db: Db, nowMs = Date.now()) {
  // --- 🩸 drag ---------------------------------------------------------------
  const dragRows = loadDragRows(db);
  const overall = summarizeDrag(dragRows);
  const drag = {
    nota:
      "Diferencia entre el precio que pagó la billetera y el que pagamos nosotros. " +
      "roiCedido = fracción del ROI esperado entregada en la entrada. Si roiCedido supera al ROI realizado, " +
      "la celda vive de un peaje invisible, no de una ventaja.",
    global: {
      n: overall.n,
      centimos: Number(overall.dragCents.toFixed(2)),
      roiCedido: pct(overall.roiGivenUp),
      roiRealizado: pct(overall.realizedRoi),
      latenciaMin: overall.latencyMinutes === null ? null : Number(overall.latencyMinutes.toFixed(1)),
    },
    porLatencia: dragBy(dragRows, latencyBucket, (k) => LATENCY_LABELS[k] ?? k).map(fmtDrag),
    porBanda: dragBy(dragRows, bandOf, (k) => bandLabel.get(k) ?? k).map(fmtDrag),
    porCategoria: dragBy(dragRows, categoryOf, (k) => CATEGORY_LABELS[k as CategoryKey] ?? k).map(fmtDrag),
  };

  // --- 🔗 confluence ---------------------------------------------------------
  const recent = loadRecentForConfluence(db, nowMs - 14 * 24 * 3600 * 1000);
  const clusters = findClusters(recent, CONFLUENCE_WINDOW_MS);
  const confluencia = {
    nota:
      "Billeteras DISTINTAS comprando el mismo resultado del mismo mercado en menos de " +
      `${CONFLUENCE_WINDOW_MS / 60000} minutos. Confirmación independiente: no depende de confiar en una sola billetera.`,
    ventanaMin: CONFLUENCE_WINDOW_MS / 60000,
    señalesObservadas: recent.length,
    racimos: clusters.length,
    racimosDe3oMas: clusters.filter((c) => c.wallets.length >= 3).length,
    ultimos: clusters.slice(0, 8).map((c) => ({
      mercado: c.marketId.slice(0, 14),
      resultado: c.outcome,
      billeteras: c.wallets.length,
    })),
  };

  // --- 🚪 exits --------------------------------------------------------------
  const settled = db
    .select({
      paperTradeId: paperTrades.id,
      track: paperTrades.track,
      stake: paperTrades.simulatedPositionSize,
      heldPnl: paperTrades.realizedPnl,
    })
    .from(paperTrades)
    .where(sql`${paperTrades.status} != 'open' AND ${paperTrades.realizedPnl} IS NOT NULL`)
    .limit(5000)
    .all();
  const paths = attachPaths(
    settled.map((s) => ({ ...s, heldPnl: s.heldPnl ?? 0 })),
    loadPaths(db, settled.map((s) => s.paperTradeId)),
  );
  const withPath = paths.filter((p) => p.path.length > 0);
  const salidas = {
    nota:
      "Simulación SOBRE EL CAMINO REAL de precios ya registrado. Dos sesgos conocidos y no corregidos: " +
      "(1) las marcas son horarias, así que un pico intermedio es invisible y esto es un PISO de lo que una regla real habría capturado; " +
      "(2) la salida se marca a precio medio, sin cruzar el spread, así que es optimista en ~1 spread por trade. " +
      "No cambia nada de cómo opera el bot: es aritmética sobre datos que ya teníamos.",
    posicionesConCamino: withPath.length,
    posicionesSinCamino: paths.length - withPath.length,
    politicas: studyExits(withPath).map((r) => ({
      regla: r.label,
      n: r.n,
      disparó: r.triggered,
      pnl: r.totalPnl,
      roi: pct(r.roi),
      piso: pct(r.lcb),
      vsAguantar: r.vsHold,
    })),
  };

  return { drag, confluencia, salidas };
}

function fmtDrag(g: { key: string; label: string; stats: ReturnType<typeof summarizeDrag> }) {
  return {
    grupo: g.label,
    n: g.stats.n,
    centimos: Number(g.stats.dragCents.toFixed(2)),
    roiCedido: pct(g.stats.roiGivenUp),
    roiRealizado: pct(g.stats.realizedRoi),
  };
}
