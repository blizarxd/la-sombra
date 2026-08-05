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
import { categorizeMarket, CATEGORY_LABELS, type CategoryKey } from "./category";
import { hourInAppTz, weekdayInAppTz } from "./format";
import { edgeStats, mean } from "./stats";

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
  /** Raw market question — the category is DERIVED from it, not from Polymarket
   *  (whose category field is ~98% null). So category slices are only as good
   *  as the text classifier, not as the exchange data. */
  marketQuestion: string | null;
  /** When the position settled. Optional: absent on older rows and on shadow
   *  (counterfactual) trades, which is why every duration metric is nullable. */
  resolvedAt?: Date | number | null;
  closedAt?: Date | number | null;
};

const ms = (d: Date | number | null | undefined): number | null =>
  d == null ? null : d instanceof Date ? d.getTime() : d;

/**
 * Hours of capital exposure: open → settle. Because every book holds to
 * resolution, this doubles as the trade's real time-to-resolution — which is why
 * there is no separate snapshot join for it.
 */
export function holdHours(t: SettledTrade): number | null {
  const open = ms(t.openedAt);
  const end = ms(t.resolvedAt) ?? ms(t.closedAt);
  if (open === null || end === null) return null;
  const h = (end - open) / 3_600_000;
  return h >= 0 ? h : null;
}

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
  /** Lower confidence bound on per-trade ROI. Null below 2 trades. */
  lcb: number | null;
  /** Same bound priced for the fact that this cell competed against every other
   *  cell in the matrix for the crown. THIS is what 🏆/🚫 are decided on. */
  strictLcb: number | null;
  /** Mean hours of capital exposure. Null when no trade in the cell has a settle time. */
  avgHoldHours: number | null;
  /** ROI per DAY of capital tied up: +8% in 4h beats +20% in 5 days. */
  roiPerDay: number | null;
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

/**
 * ⏳ How long the money stayed on the table. Collected for free from
 * openedAt→resolvedAt, and it asks a question no other dimension can: is
 * "esports ≤29¢" really about esports, or about ANY cheap market that resolves
 * within the hour? The second rule would transfer to every other category; the
 * first would not. Confusing the two is how a fluke becomes a strategy.
 */
export const HOLD_BANDS: Axis[] = [
  { key: "t00", label: "⚡ < 1h · relámpago" },
  { key: "t01", label: "🕐 1–6h" },
  { key: "t06", label: "🌗 6–24h" },
  { key: "t24", label: "📆 1–3 días" },
  { key: "t72", label: "🐢 > 3 días · capital dormido" },
];

export function holdBandKey(t: SettledTrade): string | null {
  const h = holdHours(t);
  if (h === null) return null;
  if (h < 1) return "t00";
  if (h < 6) return "t01";
  if (h < 24) return "t06";
  if (h < 72) return "t24";
  return "t72";
}

export const TRACK_AXIS: Axis[] = MATRIX_TRACKS.map((t) => ({ key: t, label: TRACK_LABELS[t] }));

// Category axis in a stable, human order (not alphabetical). "otros" last.
const CATEGORY_ORDER: CategoryKey[] = [
  "deportes",
  "esports",
  "cripto",
  "economia",
  "politica",
  "clima",
  "cultura",
  "otros",
];
export const CATEGORY_AXIS: Axis[] = CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_LABELS[c] }));

export const DIMS = {
  hourBlock: { axis: HOUR_BLOCKS, keyOf: (t: SettledTrade) => hourBlockKey(t.openedAt) } satisfies Dim,
  weekday: { axis: WEEKDAYS, keyOf: (t: SettledTrade) => weekdayKey(t.openedAt) } satisfies Dim,
  priceBand: { axis: PRICE_BANDS, keyOf: (t: SettledTrade) => priceBandKey(t.entryPrice) } satisfies Dim,
  track: {
    axis: TRACK_AXIS,
    keyOf: (t: SettledTrade) => ((MATRIX_TRACKS as readonly string[]).includes(t.track) ? t.track : null),
  } satisfies Dim,
  category: { axis: CATEGORY_AXIS, keyOf: (t: SettledTrade) => categorizeMarket(t.marketQuestion) } satisfies Dim,
  holdBand: { axis: HOLD_BANDS, keyOf: (t: SettledTrade) => holdBandKey(t) } satisfies Dim,
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const round2 = (x: number) => Math.round(x * 100) / 100;

export function buildMatrix(
  trades: SettledTrade[],
  spec: { id: string; title: string; hint: string; minSample: number; rowDim: Dim; colDim: Dim },
): Matrix {
  type Agg = { pnl: number; staked: number; count: number; wins: number; rois: number[]; holds: number[] };
  const grid = new Map<string, Map<string, Agg>>(); // rowKey -> colKey -> agg
  let sampleSize = 0;

  for (const t of trades) {
    const rowKey = spec.rowDim.keyOf(t);
    const colKey = spec.colDim.keyOf(t);
    if (!rowKey || !colKey) continue;
    sampleSize++;
    const row = grid.get(rowKey) ?? new Map<string, Agg>();
    const agg = row.get(colKey) ?? { pnl: 0, staked: 0, count: 0, wins: 0, rois: [], holds: [] };
    const pnl = t.realizedPnl ?? 0;
    const stake = t.simulatedPositionSize || 0;
    agg.pnl += pnl;
    agg.staked += stake;
    agg.count += 1;
    if (pnl > 0) agg.wins += 1;
    if (stake > 0) agg.rois.push(pnl / stake); // per-trade ROI — the unit the bounds need
    const h = holdHours(t);
    if (h !== null) agg.holds.push(h);
    row.set(colKey, agg);
    grid.set(rowKey, row);
  }

  // Every cell in this matrix competed for the crown; that is the multiplicity
  // the strict bound has to price in.
  const cellsTested = [...grid.values()].reduce((a, row) => a + row.size, 0);

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
      const stats = edgeStats(agg.rois, cellsTested);
      const roi = agg.staked > 0 ? agg.pnl / agg.staked : 0;
      // Clamp to an hour: a market that settles in 4 minutes would otherwise
      // report a four-figure "ROI per day" that no capital could ever harvest.
      const avgHold = agg.holds.length > 0 ? mean(agg.holds) : null;
      const days = avgHold === null ? null : Math.max(avgHold, 1) / 24;
      cells[col.key] = {
        pnl: round2(agg.pnl),
        roi,
        count: agg.count,
        winRate: agg.wins / agg.count,
        lcb: stats.lcb,
        strictLcb: stats.strictLcb,
        avgHoldHours: avgHold === null ? null : round2(avgHold),
        roiPerDay: days === null || days <= 0 ? null : roi / days,
      };
      totalPnl += agg.pnl;
      totalCount += agg.count;
    }
    rows.push({ key: axis.key, label: axis.label, cells, totalPnl: round2(totalPnl), totalCount });
  }

  // The crowns used to be handed out on RAW ROI, so a 5-trade fluke could beat a
  // 300-trade edge and get read as a finding. They are now decided on the
  // multiplicity-corrected lower bound: what is the worst this cell plausibly
  // is, given that it won a contest against every other cell here?
  const bestPerCol: Record<string, string | null> = {};
  const worstPerCol: Record<string, string | null> = {};
  for (const col of spec.colDim.axis) {
    let qualifying = 0;
    let best: { key: string; score: number } | null = null;
    let worst: { key: string; score: number } | null = null;
    for (const row of rows) {
      const cell = row.cells[col.key];
      if (!cell || cell.count < spec.minSample || cell.strictLcb === null) continue;
      qualifying++;
      if (!best || cell.strictLcb > best.score) best = { key: row.key, score: cell.strictLcb };
      // 🚫 is a WARNING, not a wooden spoon: it goes to a cell that loses even
      // under generous assumptions (upper bound still below zero). "Least good
      // among winners" is a ranking artefact and must never be flagged as a leak.
      const upper = cell.roi + (cell.roi - cell.strictLcb);
      if (upper < 0 && (!worst || upper < worst.score)) worst = { key: row.key, score: upper };
    }
    // With a single qualifying cell there is no contest to win.
    bestPerCol[col.key] = qualifying >= 2 && best ? best.key : null;
    worstPerCol[col.key] = qualifying >= 2 && worst ? worst.key : null;
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
        .map((x) => {
          // The bound is spelled out for the model too: a headline ROI with a
          // negative floor is a hypothesis, and it should argue like it is one.
          const floor = x.cell.strictLcb === null ? "s/d" : `${(x.cell.strictLcb * 100).toFixed(1)}%`;
          const perDay = x.cell.roiPerDay === null ? "" : `, ROI/día ${(x.cell.roiPerDay * 100).toFixed(1)}%`;
          const hold = x.cell.avgHoldHours === null ? "" : `, dura ${x.cell.avgHoldHours.toFixed(1)}h`;
          return `${row.label} × ${x.col.label}: PnL ${x.cell.pnl.toFixed(2)}, ROI ${(x.cell.roi * 100).toFixed(1)}%, piso ${floor}, n=${
            x.cell.count
          }, aciertos ${(x.cell.winRate * 100).toFixed(0)}%${perDay}${hold}`;
        }),
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
    buildMatrix(trades, {
      id: "category-track",
      title: "🏷️ Categoría × brazo",
      hint: "¿Qué deporte/tema rinde en cada libro? OJO: la categoría la deducimos del texto (Polymarket la deja ~98% vacía), no es dato de la casa.",
      minSample: 5,
      rowDim: DIMS.category,
      colDim: DIMS.track,
    }),
    buildMatrix(trades, {
      id: "category-band",
      title: "🏷️💲 Categoría × banda de entrada",
      hint: "El cruce que buscas: ¿qué juego rinde a qué precio? Aquí aparece si p.ej. esports solo paga cuando entras barato.",
      minSample: 5,
      rowDim: DIMS.category,
      colDim: DIMS.priceBand,
    }),
    buildMatrix(trades, {
      id: "category-hour",
      title: "🏷️🕐 Categoría × franja horaria",
      hint: "¿A qué hora del día aparece y rinde cada categoría? (recuerda: la hora es a menudo un proxy de qué liga juega).",
      minSample: 5,
      rowDim: DIMS.category,
      colDim: DIMS.hourBlock,
    }),
    buildMatrix(trades, {
      id: "hold-track",
      title: "⏳ Duración hasta resolver × brazo",
      hint: "Cuánto tiempo queda el dinero atado. Un +8% en 4h rota seis veces al día; un +20% en 5 días, no. Mira la columna ROI/día, no el ROI.",
      minSample: 5,
      rowDim: DIMS.holdBand,
      colDim: DIMS.track,
    }),
    buildMatrix(trades, {
      id: "hold-category",
      title: "⏳🏷️ Duración × categoría",
      hint: "La pregunta que desarma un espejismo: ¿'esports barato' rinde por ser esports, o por resolverse en menos de una hora? Si es lo segundo, la regla sirve para TODAS las categorías.",
      minSample: 5,
      rowDim: DIMS.holdBand,
      colDim: DIMS.category,
    }),
  ];
}
