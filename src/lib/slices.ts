/**
 * Slice matrices — "¿cuándo y a qué precio nos va mejor?"
 *
 * Every matrix is a 2D grid over SETTLED paper trades: a row dimension (hour
 * block / weekday / entry-price band) crossed with a column dimension (book, or
 * weekday). Cells carry PnL, ROI, sample count and win rate.
 *
 * HONEST-STATS NOTE (learned the hard way on botpolym): slicing the same ~1k
 * trades a dozen ways WILL surface hot cells that are pure noise. Two guards:
 *   1. `minSample` — a cell is never crowned (🏆) or condemned (🚫) below it.
 *   2. Nothing here auto-tunes anything. These matrices produce HYPOTHESES for
 *      the operator and the AI cut to argue about — never rules. The moment a
 *      matrix cell silently becomes a live filter, we are curve-fitting.
 */
import { hourInAppTz, weekdayInAppTz } from "./format";

export const MATRIX_TRACKS = ["core", "live", "trade", "crypto", "elite"] as const;
export type MatrixTrack = (typeof MATRIX_TRACKS)[number];

export const TRACK_LABELS: Record<MatrixTrack, string> = {
  core: "Pre-partido",
  live: "En Vivo",
  trade: "Cuota",
  crypto: "Cripto",
  elite: "La Crema",
};

/** A settled paper trade, reduced to the fields the slices need. */
export type SettledTrade = {
  track: string;
  entryPrice: number;
  simulatedPositionSize: number;
  realizedPnl: number | null;
  openedAt: Date | number;
};

export type Axis = { key: string; label: string };

export type Dim = {
  /** Fixed, ordered axis values — matrices read better in a stable order. */
  axis: Axis[];
  keyOf: (t: SettledTrade) => string | null;
};

export type MatrixCell = {
  pnl: number;
  /** realized PnL / total USD staked. The fair metric — position sizes differ per book. */
  roi: number;
  count: number;
  winRate: number;
};

export type MatrixRow = {
  key: string;
  label: string;
  cells: Record<string, MatrixCell | null>;
  totalPnl: number;
  totalCount: number;
};

export type Matrix = {
  id: string;
  title: string;
  hint: string;
  minSample: number;
  cols: Axis[];
  rows: MatrixRow[];
  /** Per column: the row key with the best ROI among cells with >= minSample. */
  bestPerCol: Record<string, string | null>;
  worstPerCol: Record<string, string | null>;
  /** Settled trades that fed this matrix. */
  sampleSize: number;
};

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** 4-hour blocks. Individual hours slice ~1k trades far too thin to trust. */
export const HOUR_BLOCKS: Axis[] = [
  { key: "00", label: "🌙 Madrugada · 00–03" },
  { key: "04", label: "🌅 Amanecer · 04–07" },
  { key: "08", label: "☀️ Mañana · 08–11" },
  { key: "12", label: "🍽️ Mediodía · 12–15" },
  { key: "16", label: "🌇 Tarde · 16–19" },
  { key: "20", label: "🌃 Noche · 20–23" },
];

export function hourBlockKey(d: Date | number): string {
  const start = Math.floor(hourInAppTz(d) / 4) * 4;
  return String(start).padStart(2, "0");
}

export const WEEKDAYS: Axis[] = [
  { key: "1", label: "Lunes" },
  { key: "2", label: "Martes" },
  { key: "3", label: "Miércoles" },
  { key: "4", label: "Jueves" },
  { key: "5", label: "Viernes" },
  { key: "6", label: "Sábado" },
  { key: "0", label: "Domingo" },
];

export function weekdayKey(d: Date | number): string {
  return String(weekdayInAppTz(d));
}

/**
 * Entry-price bands. On botpolym the winning lever turned out to be the entry
 * band (60–74¢), not the asset or the hour — so this matrix earns its place.
 */
export const PRICE_BANDS: Axis[] = [
  { key: "p00", label: "≤ 29¢ · tiro largo" },
  { key: "p30", label: "30–44¢" },
  { key: "p45", label: "45–59¢ · moneda al aire" },
  { key: "p60", label: "60–74¢" },
  { key: "p75", label: "75–89¢ · favorito" },
  { key: "p90", label: "≥ 90¢ · casi hecho" },
];

export function priceBandKey(entryPrice: number): string | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice > 1) return null;
  if (entryPrice < 0.3) return "p00";
  if (entryPrice < 0.45) return "p30";
  if (entryPrice < 0.6) return "p45";
  if (entryPrice < 0.75) return "p60";
  if (entryPrice < 0.9) return "p75";
  return "p90";
}

export const TRACK_AXIS: Axis[] = MATRIX_TRACKS.map((t) => ({ key: t, label: TRACK_LABELS[t] }));

export const DIMS = {
  hourBlock: { axis: HOUR_BLOCKS, keyOf: (t: SettledTrade) => hourBlockKey(t.openedAt) } satisfies Dim,
  weekday: { axis: WEEKDAYS, keyOf: (t: SettledTrade) => weekdayKey(t.openedAt) } satisfies Dim,
  priceBand: { axis: PRICE_BANDS, keyOf: (t: SettledTrade) => priceBandKey(t.entryPrice) } satisfies Dim,
  track: {
    axis: TRACK_AXIS,
    keyOf: (t: SettledTrade) => ((MATRIX_TRACKS as readonly string[]).includes(t.track) ? t.track : null),
  } satisfies Dim,
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const round2 = (x: number) => Math.round(x * 100) / 100;

export function buildMatrix(
  trades: SettledTrade[],
  spec: { id: string; title: string; hint: string; minSample: number; rowDim: Dim; colDim: Dim },
): Matrix {
  type Agg = { pnl: number; staked: number; count: number; wins: number };
  const grid = new Map<string, Map<string, Agg>>(); // rowKey -> colKey -> agg
  let sampleSize = 0;

  for (const t of trades) {
    const rowKey = spec.rowDim.keyOf(t);
    const colKey = spec.colDim.keyOf(t);
    if (!rowKey || !colKey) continue;
    sampleSize++;
    const row = grid.get(rowKey) ?? new Map<string, Agg>();
    const agg = row.get(colKey) ?? { pnl: 0, staked: 0, count: 0, wins: 0 };
    const pnl = t.realizedPnl ?? 0;
    agg.pnl += pnl;
    agg.staked += t.simulatedPositionSize || 0;
    agg.count += 1;
    if (pnl > 0) agg.wins += 1;
    row.set(colKey, agg);
    grid.set(rowKey, row);
  }

  const rows: MatrixRow[] = [];
  for (const axis of spec.rowDim.axis) {
    const row = grid.get(axis.key);
    if (!row || row.size === 0) continue; // never render an all-empty row
    const cells: Record<string, MatrixCell | null> = {};
    let totalPnl = 0;
    let totalCount = 0;
    for (const col of spec.colDim.axis) {
      const agg = row.get(col.key);
      if (!agg || agg.count === 0) {
        cells[col.key] = null;
        continue;
      }
      cells[col.key] = {
        pnl: round2(agg.pnl),
        roi: agg.staked > 0 ? agg.pnl / agg.staked : 0,
        count: agg.count,
        winRate: agg.wins / agg.count,
      };
      totalPnl += agg.pnl;
      totalCount += agg.count;
    }
    rows.push({ key: axis.key, label: axis.label, cells, totalPnl: round2(totalPnl), totalCount });
  }

  const bestPerCol: Record<string, string | null> = {};
  const worstPerCol: Record<string, string | null> = {};
  for (const col of spec.colDim.axis) {
    let best: { key: string; roi: number } | null = null;
    let worst: { key: string; roi: number } | null = null;
    for (const row of rows) {
      const cell = row.cells[col.key];
      if (!cell || cell.count < spec.minSample) continue;
      if (!best || cell.roi > best.roi) best = { key: row.key, roi: cell.roi };
      if (!worst || cell.roi < worst.roi) worst = { key: row.key, roi: cell.roi };
    }
    // With a single qualifying cell there is no "best vs worst" to speak of.
    const twoOrMore = best && worst && best.key !== worst.key;
    bestPerCol[col.key] = twoOrMore ? best!.key : null;
    worstPerCol[col.key] = twoOrMore ? worst!.key : null;
  }

  return {
    id: spec.id,
    title: spec.title,
    hint: spec.hint,
    minSample: spec.minSample,
    cols: spec.colDim.axis,
    rows,
    bestPerCol,
    worstPerCol,
    sampleSize,
  };
}

/**
 * Compact, AI-facing serialization: only cells that clear `minSample`. Feeding
 * the model the thin cells too would just invite it to hallucinate patterns out
 * of 2-trade samples — the exact failure mode these matrices exist to avoid.
 */
export function summarizeMatrices(matrices: Matrix[]) {
  return matrices.map((m) => ({
    id: m.id,
    title: m.title,
    minSample: m.minSample,
    cells: m.rows.flatMap((row) =>
      m.cols
        .map((col) => ({ col, cell: row.cells[col.key] }))
        .filter((x): x is { col: Axis; cell: MatrixCell } => !!x.cell && x.cell.count >= m.minSample)
        .map(
          (x) =>
            `${row.label} × ${x.col.label}: PnL ${x.cell.pnl.toFixed(2)}, ROI ${(x.cell.roi * 100).toFixed(1)}%, n=${
              x.cell.count
            }, aciertos ${(x.cell.winRate * 100).toFixed(0)}%`,
        ),
    ),
  }));
}

/** The four matrices the dashboard (and the AI cut) reason over. */
export function buildAllMatrices(trades: SettledTrade[]): Matrix[] {
  return [
    buildMatrix(trades, {
      id: "hour-track",
      title: "🕐 Franja horaria × brazo",
      hint: "¿A qué hora del día (tu hora) abre cada libro sus mejores copias?",
      minSample: 5,
      rowDim: DIMS.hourBlock,
      colDim: DIMS.track,
    }),
    buildMatrix(trades, {
      id: "band-track",
      title: "💲 Banda de entrada × brazo",
      hint: "¿A qué precio de entrada rinde cada libro? En botpolym esta fue la palanca real, más que la hora.",
      minSample: 5,
      rowDim: DIMS.priceBand,
      colDim: DIMS.track,
    }),
    buildMatrix(trades, {
      id: "weekday-track",
      title: "📅 Día de la semana × brazo",
      hint: "¿Hay días muertos? ¿El finde rinde distinto al entre semana?",
      minSample: 5,
      rowDim: DIMS.weekday,
      colDim: DIMS.track,
    }),
    buildMatrix(trades, {
      id: "hour-weekday",
      title: "🔥 Franja × día (todos los brazos juntos)",
      hint: "El mapa de calor completo. Así apareció el 'Bloque del Finde' en botpolym: no fue la hora sola ni el día solo, fue el cruce.",
      minSample: 8,
      rowDim: DIMS.hourBlock,
      colDim: DIMS.weekday,
    }),
  ];
}
