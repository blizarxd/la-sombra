import type { CategoryKey } from "./category";
import { categorizeMarket, CATEGORY_LABELS } from "./category";
import {
  HOUR_BLOCKS,
  PRICE_BANDS,
  TRACK_LABELS,
  hourBlockKey,
  priceBandKey,
  type MatrixTrack,
  type SettledTrade,
} from "./slices";

/**
 * 🧬 El Buscador de Oro — the engine that makes La Crema auto-evolving.
 *
 * Until 2026-07-20 the hybrid's gold cells were HARDCODED from a manual matrix
 * scan (cremaCells.ts). This module is that same scan, made repeatable: every
 * daily cut it re-derives which matrix cells are gold (enter) and which are
 * traps (veto) from the settled paper trades, across four time windows, with
 * the SAME survivorship standard the manual scan used — positive in EVERY
 * window where the cell has a sample, with n≥30 overall.
 *
 * Honest-stats guards, pre-registered (see slices.ts for why this matters):
 *   · A cell needs 2 CONSECUTIVE daily scans as a survivor to activate, and
 *     2 consecutive failing scans to be pruned — no single lucky day flips
 *     the strategy. (Matches the "2 revisiones" rule published on /elite.)
 *   · Weekday-based cells are deliberately NOT candidates: with ~2 weeks of
 *     data a weekday cell has 1-2 observations of itself, i.e. pure noise
 *     ("mañana × miércoles +31.6%" is one lucky Wednesday, not a law).
 *   · clima and cripto trades never enter the scan or the strategy at all.
 *
 * Everything here is PURE and paper-only: it reads settled simulated trades
 * and returns verdicts. No orders, ever.
 */

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** The dims a cell can pin. A trade matches a cell iff every defined dim matches. */
export type CellParams = {
  arm?: MatrixTrack;
  category?: CategoryKey;
  hourBlock?: string; // HOUR_BLOCKS key, e.g. "08"
  priceBand?: string; // PRICE_BANDS key, e.g. "p00"
};

export type CellKind = "gold" | "trap";

export type WindowStats = { n: number; roi: number; winRate: number; pnl: number };

export type CellScan = {
  id: string;
  label: string;
  params: CellParams;
  /** Per-window stats; only windows with n >= MIN_WINDOW_N count as evidence. */
  windows: Record<string, WindowStats>;
};

/** Categories that never enter the strategy — red in every arm and window. */
export const HARD_EXCLUDED_CATEGORIES: ReadonlySet<CategoryKey> = new Set<CategoryKey>(["clima", "cripto"]);

export const SCAN_WINDOWS: Array<{ key: string; ms: number | null }> = [
  { key: "all", ms: null },
  { key: "30d", ms: 30 * 24 * 3600 * 1000 },
  { key: "15d", ms: 15 * 24 * 3600 * 1000 },
  { key: "7d", ms: 7 * 24 * 3600 * 1000 },
];

// Survivorship standard — the same numbers the manual 2026-07-20 scan used.
export const MIN_CELL_N = 30; // overall sample to even be considered
export const MIN_WINDOW_N = 10; // a window below this neither confirms nor kills
export const MIN_GOLD_ROI = 0.05; // +5% overall to be gold
export const MAX_TRAP_ROI = -0.05; // −5% overall to be a trap
export const HITS_TO_ACTIVATE = 2; // consecutive surviving scans
export const MISSES_TO_RETIRE = 2; // consecutive failing scans
export const MAX_ACTIVE_GOLD = 12; // soft cap: never let "everything" be gold

const hourLabel = new Map(HOUR_BLOCKS.map((a) => [a.key, a.label]));
const bandLabel = new Map(PRICE_BANDS.map((a) => [a.key, a.label]));

export function cellLabel(params: CellParams): string {
  const parts: string[] = [];
  if (params.arm) parts.push(TRACK_LABELS[params.arm]);
  if (params.category) parts.push(CATEGORY_LABELS[params.category]);
  if (params.priceBand) parts.push(bandLabel.get(params.priceBand) ?? params.priceBand);
  if (params.hourBlock) parts.push(hourLabel.get(params.hourBlock) ?? params.hourBlock);
  return parts.join(" × ") || "(global)";
}

/** Canonical, stable cell id — this is what gets stamped on paper_trades.gold_rule. */
export function cellId(params: CellParams): string {
  if (params.category && params.hourBlock) return `cat-hour:${params.category}:${params.hourBlock}`;
  if (params.category && params.priceBand) return `cat-band:${params.category}:${params.priceBand}`;
  if (params.arm && params.priceBand) return `arm-band:${params.arm}:${params.priceBand}`;
  if (params.arm && params.hourBlock) return `arm-hour:${params.arm}:${params.hourBlock}`;
  if (params.priceBand && params.hourBlock) return `band-hour:${params.priceBand}:${params.hourBlock}`;
  if (params.hourBlock) return `hour:${params.hourBlock}`;
  throw new Error("unsupported cell shape");
}

export function parseCellId(id: string): CellParams | null {
  const p = id.split(":");
  switch (p[0]) {
    case "hour":
      return { hourBlock: p[1] };
    case "cat-hour":
      return { category: p[1] as CategoryKey, hourBlock: p[2] };
    case "cat-band":
      return { category: p[1] as CategoryKey, priceBand: p[2] };
    case "arm-band":
      return { arm: p[1] as MatrixTrack, priceBand: p[2] };
    case "arm-hour":
      return { arm: p[1] as MatrixTrack, hourBlock: p[2] };
    case "band-hour":
      return { priceBand: p[1], hourBlock: p[2] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** What the engine needs to know about one settled trade. */
export type ScanTrade = SettledTrade;

type TradeKeys = { arm: MatrixTrack | null; category: CategoryKey; hourBlock: string; priceBand: string | null };

function keysOf(t: ScanTrade): TradeKeys {
  return {
    arm: (["core", "live", "trade", "crypto"] as const).includes(t.track as never) ? (t.track as MatrixTrack) : null,
    category: categorizeMarket(t.marketQuestion),
    hourBlock: hourBlockKey(t.openedAt),
    priceBand: priceBandKey(t.entryPrice),
  };
}

/** Every candidate cell this one trade belongs to. Weekday dims stay out on purpose. */
function memberCells(k: TradeKeys): CellParams[] {
  const out: CellParams[] = [{ hourBlock: k.hourBlock }];
  out.push({ category: k.category, hourBlock: k.hourBlock });
  if (k.priceBand) {
    out.push({ category: k.category, priceBand: k.priceBand });
    out.push({ priceBand: k.priceBand, hourBlock: k.hourBlock });
    if (k.arm) out.push({ arm: k.arm, priceBand: k.priceBand });
  }
  if (k.arm) out.push({ arm: k.arm, hourBlock: k.hourBlock });
  return out;
}

/**
 * Scan all settled trades and return the surviving gold cells and trap cells.
 * Gold: n≥30 overall, ROI ≥ +5% overall, ROI ≥ 0 in every window with n≥10.
 * Trap: the mirror image (≤ −5% overall, ≤ 0 everywhere it has a sample).
 */
export function scanCells(trades: ScanTrade[], nowMs: number): { gold: CellScan[]; traps: CellScan[] } {
  type Agg = { n: number; staked: number; pnl: number; wins: number };
  const byCell = new Map<string, { params: CellParams; windows: Map<string, Agg> }>();

  for (const t of trades) {
    if (t.realizedPnl == null) continue;
    const k = keysOf(t);
    if (HARD_EXCLUDED_CATEGORIES.has(k.category)) continue; // never copyable → never scanned
    const openedMs = t.openedAt instanceof Date ? t.openedAt.getTime() : t.openedAt;
    for (const params of memberCells(k)) {
      const id = cellId(params);
      const entry = byCell.get(id) ?? { params, windows: new Map<string, Agg>() };
      for (const w of SCAN_WINDOWS) {
        if (w.ms !== null && openedMs < nowMs - w.ms) continue;
        const agg = entry.windows.get(w.key) ?? { n: 0, staked: 0, pnl: 0, wins: 0 };
        agg.n += 1;
        agg.staked += t.simulatedPositionSize || 0;
        agg.pnl += t.realizedPnl;
        if (t.realizedPnl > 0) agg.wins += 1;
        entry.windows.set(w.key, agg);
      }
      byCell.set(id, entry);
    }
  }

  const gold: CellScan[] = [];
  const traps: CellScan[] = [];
  for (const [id, entry] of byCell) {
    const all = entry.windows.get("all");
    if (!all || all.n < MIN_CELL_N || all.staked <= 0) continue;
    const windows: Record<string, WindowStats> = {};
    for (const [wk, agg] of entry.windows) {
      windows[wk] = {
        n: agg.n,
        roi: agg.staked > 0 ? agg.pnl / agg.staked : 0,
        winRate: agg.n > 0 ? agg.wins / agg.n : 0,
        pnl: Math.round(agg.pnl * 100) / 100,
      };
    }
    const roiAll = windows.all.roi;
    const evidenced = Object.entries(windows).filter(([, s]) => s.n >= MIN_WINDOW_N);
    const scan: CellScan = { id, label: cellLabel(entry.params), params: entry.params, windows };
    if (roiAll >= MIN_GOLD_ROI && evidenced.every(([, s]) => s.roi >= 0)) gold.push(scan);
    else if (roiAll <= MAX_TRAP_ROI && evidenced.every(([, s]) => s.roi <= 0)) traps.push(scan);
  }

  gold.sort((a, b) => b.windows.all.roi - a.windows.all.roi);
  traps.sort((a, b) => a.windows.all.roi - b.windows.all.roi);
  return { gold, traps };
}

// ---------------------------------------------------------------------------
// Hysteresis — the pre-registered lifecycle
// ---------------------------------------------------------------------------

export type CellRow = {
  id: string;
  kind: CellKind;
  label: string;
  params: CellParams;
  status: "candidata" | "activa" | "retirada";
  hits: number;
  misses: number;
  windows: Record<string, WindowStats> | null;
  firstSeenAt: number;
  activatedAt: number | null;
  retiredAt: number | null;
};

export type CellEvent = { cellId: string; action: string; detail: string };

/**
 * Fold one scan into the tracked cell rows. Pure: returns the new rows plus the
 * transition events (which the caller persists and may push to Telegram).
 */
export function applyScan(
  existing: CellRow[],
  scan: { gold: CellScan[]; traps: CellScan[] },
  nowMs: number,
): { rows: CellRow[]; events: CellEvent[] } {
  const rows = new Map(existing.map((r) => [r.id, { ...r }]));
  const events: CellEvent[] = [];
  const seen = new Set<string>();

  const fmt = (s: CellScan) =>
    `ROI ${(s.windows.all.roi * 100).toFixed(1)}% · n=${s.windows.all.n} · 7d ${
      s.windows["7d"] ? `${(s.windows["7d"].roi * 100).toFixed(1)}% (n=${s.windows["7d"].n})` : "sin muestra"
    }`;

  const activeGoldCount = () => [...rows.values()].filter((r) => r.kind === "gold" && r.status === "activa").length;

  const fold = (kind: CellKind, survivors: CellScan[]) => {
    for (const s of survivors) {
      seen.add(s.id);
      const prev = rows.get(s.id);
      if (!prev) {
        rows.set(s.id, {
          id: s.id,
          kind,
          label: s.label,
          params: s.params,
          status: "candidata",
          hits: 1,
          misses: 0,
          windows: s.windows,
          firstSeenAt: nowMs,
          activatedAt: null,
          retiredAt: null,
        });
        events.push({ cellId: s.id, action: "candidata", detail: `${s.label} — ${fmt(s)}` });
        continue;
      }
      // A cell that survives can only be its own kind — a cell can't be gold
      // one day and trap the next without passing through failure first.
      prev.kind = kind;
      prev.hits += 1;
      prev.misses = 0;
      prev.windows = s.windows;
      prev.label = s.label;
      if (prev.status !== "activa" && prev.hits >= HITS_TO_ACTIVATE) {
        if (kind === "gold" && activeGoldCount() >= MAX_ACTIVE_GOLD) {
          events.push({ cellId: s.id, action: "en-espera", detail: `${s.label} califica pero el cupo de ${MAX_ACTIVE_GOLD} celdas está lleno — ${fmt(s)}` });
        } else {
          const was = prev.status;
          prev.status = "activa";
          prev.activatedAt = nowMs;
          prev.retiredAt = null;
          events.push({
            cellId: s.id,
            action: was === "retirada" ? "reactivada" : "activada",
            detail: `${s.label} — ${prev.hits} escaneos seguidos como sobreviviente · ${fmt(s)}`,
          });
        }
      }
    }
  };

  fold("gold", scan.gold);
  fold("trap", scan.traps);

  // Cells NOT seen this scan: strike them.
  for (const r of rows.values()) {
    if (seen.has(r.id) || r.status === "retirada") continue;
    r.misses += 1;
    r.hits = 0;
    if (r.misses >= MISSES_TO_RETIRE) {
      const was = r.status;
      r.status = "retirada";
      r.retiredAt = nowMs;
      events.push({
        cellId: r.id,
        action: was === "activa" ? "podada" : "descartada",
        detail: `${r.label} — ${r.misses} escaneos seguidos sin sobrevivir el estándar (positiva en TODAS las ventanas, n≥${MIN_CELL_N})`,
      });
    }
  }

  return { rows: [...rows.values()], events };
}

// ---------------------------------------------------------------------------
// Runtime verdict
// ---------------------------------------------------------------------------

export type GoldVerdict = { gold: boolean; reason: string; ruleId?: string };

export type VerdictInput = {
  arm: MatrixTrack;
  category: CategoryKey;
  hourInAppTz: number;
  entryPrice: number;
};

function matches(params: CellParams, input: VerdictInput, hourBlock: string, priceBand: string | null): boolean {
  if (params.arm && params.arm !== input.arm) return false;
  if (params.category && params.category !== input.category) return false;
  if (params.hourBlock && params.hourBlock !== hourBlock) return false;
  if (params.priceBand && params.priceBand !== priceBand) return false;
  return true;
}

/**
 * Is this trade in an ACTIVE gold cell (and no active trap cell)? Traps veto —
 * that is how e.g. "esports at night" stays out even though "esports ≤29¢" is
 * gold. Attribution goes to the matching gold cell with the best overall ROI,
 * so the /elite pruning board judges the sharpest claim, deterministically.
 */
export function verdictFromCells(active: CellRow[], input: VerdictInput): GoldVerdict {
  if (HARD_EXCLUDED_CATEGORIES.has(input.category)) {
    return { gold: false, reason: `categoría ${input.category} excluida (roja en toda la matriz)` };
  }
  const hourBlock = String(Math.floor(input.hourInAppTz / 4) * 4).padStart(2, "0");
  const priceBand = priceBandKey(input.entryPrice);

  const trap = active.find((r) => r.kind === "trap" && r.status === "activa" && matches(r.params, input, hourBlock, priceBand));
  if (trap) return { gold: false, reason: `vetado por celda trampa: ${trap.label}` };

  const golds = active
    .filter((r) => r.kind === "gold" && r.status === "activa" && matches(r.params, input, hourBlock, priceBand))
    .sort((a, b) => (b.windows?.all?.roi ?? 0) - (a.windows?.all?.roi ?? 0) || a.id.localeCompare(b.id));
  if (golds.length === 0) {
    return { gold: false, reason: `no cae en ninguna celda de oro activa (${input.category}, h${input.hourInAppTz}, ${Math.round(input.entryPrice * 100)}¢)` };
  }
  const best = golds[0];
  return { gold: true, ruleId: best.id, reason: `celda de oro: ${best.label}` };
}
