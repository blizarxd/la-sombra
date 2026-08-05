import type { CategoryKey } from "./category";
import { categorizeMarket, CATEGORY_LABELS } from "./category";
import {
  HOLD_BANDS,
  HOUR_BLOCKS,
  PRICE_BANDS,
  TRACK_LABELS,
  holdBandKey,
  holdHours,
  hourBlockKey,
  priceBandKey,
  type MatrixTrack,
  type SettledTrade,
} from "./slices";
import { edgeStats, mean } from "./stats";

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
  /**
   * HOLD_BANDS key, e.g. "t00". Asks whether a vein is really about its category
   * or just about how fast the market settles — a rule that transfers vs one
   * that does not.
   */
  holdBand?: string;
};

export type CellKind = "gold" | "trap";

/** Which stream a cell's evidence came from. Shadow nominates, real confirms. */
export type EvidenceSource = "real" | "shadow";

export type WindowStats = {
  n: number;
  roi: number;
  winRate: number;
  pnl: number;
  /** Shrunk lower bound on per-trade ROI. Null below 2 trades. */
  lcb: number | null;
  /** Same bound, priced for the fact this cell competed against every other. */
  strictLcb: number | null;
  /** Mean hours of capital exposure; null when settle times are unknown. */
  avgHoldHours: number | null;
  /** ROI per day of capital tied up. */
  roiPerDay: number | null;
};

export type CellScan = {
  id: string;
  label: string;
  params: CellParams;
  /** Per-window stats; only windows with n >= MIN_WINDOW_N count as evidence. */
  windows: Record<string, WindowStats>;
  source: EvidenceSource;
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

/**
 * The shadow stream is ~100× the volume of the real one (every declined signal
 * gets a counterfactual, ~8.8k/day vs ~69 copies/day) and it pays NO spread and
 * suffers NO slippage. Cheap to accumulate, so it must be expensive to qualify:
 * a much larger sample, and it still only ever produces a SUSPICION.
 */
export const MIN_SHADOW_N = 150;

/**
 * 🎲 Share of La Crema's copies reserved for the least-known cells.
 *
 * Without it the engine is circular: it can only gather evidence about cells it
 * already trades, so it confirms its seeds forever and never finds a new vein.
 * This is the price of not going blind, and it is booked separately.
 */
export const EXPLORE_BUDGET = 0.12;

const hourLabel = new Map(HOUR_BLOCKS.map((a) => [a.key, a.label]));
const bandLabel = new Map(PRICE_BANDS.map((a) => [a.key, a.label]));
const holdLabel = new Map(HOLD_BANDS.map((a) => [a.key, a.label]));

export function cellLabel(params: CellParams): string {
  const parts: string[] = [];
  if (params.arm) parts.push(TRACK_LABELS[params.arm]);
  if (params.category) parts.push(CATEGORY_LABELS[params.category]);
  if (params.priceBand) parts.push(bandLabel.get(params.priceBand) ?? params.priceBand);
  if (params.hourBlock) parts.push(hourLabel.get(params.hourBlock) ?? params.hourBlock);
  if (params.holdBand) parts.push(holdLabel.get(params.holdBand) ?? params.holdBand);
  return parts.join(" × ") || "(global)";
}

/** Canonical, stable cell id — this is what gets stamped on paper_trades.gold_rule. */
export function cellId(params: CellParams): string {
  if (params.category && params.holdBand) return `cat-hold:${params.category}:${params.holdBand}`;
  if (params.priceBand && params.holdBand) return `band-hold:${params.priceBand}:${params.holdBand}`;
  if (params.category && params.hourBlock) return `cat-hour:${params.category}:${params.hourBlock}`;
  if (params.category && params.priceBand) return `cat-band:${params.category}:${params.priceBand}`;
  if (params.arm && params.priceBand) return `arm-band:${params.arm}:${params.priceBand}`;
  if (params.arm && params.hourBlock) return `arm-hour:${params.arm}:${params.hourBlock}`;
  if (params.priceBand && params.hourBlock) return `band-hour:${params.priceBand}:${params.hourBlock}`;
  if (params.holdBand) return `hold:${params.holdBand}`;
  if (params.hourBlock) return `hour:${params.hourBlock}`;
  throw new Error("unsupported cell shape");
}

export function parseCellId(id: string): CellParams | null {
  const p = id.split(":");
  switch (p[0]) {
    case "hour":
      return { hourBlock: p[1] };
    case "hold":
      return { holdBand: p[1] };
    case "cat-hour":
      return { category: p[1] as CategoryKey, hourBlock: p[2] };
    case "cat-band":
      return { category: p[1] as CategoryKey, priceBand: p[2] };
    case "cat-hold":
      return { category: p[1] as CategoryKey, holdBand: p[2] };
    case "band-hold":
      return { priceBand: p[1], holdBand: p[2] };
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

type TradeKeys = {
  arm: MatrixTrack | null;
  category: CategoryKey;
  hourBlock: string;
  priceBand: string | null;
  holdBand: string | null;
};

function keysOf(t: ScanTrade): TradeKeys {
  return {
    arm: (["core", "live", "trade", "crypto"] as const).includes(t.track as never) ? (t.track as MatrixTrack) : null,
    category: categorizeMarket(t.marketQuestion),
    hourBlock: hourBlockKey(t.openedAt),
    priceBand: priceBandKey(t.entryPrice),
    holdBand: holdBandKey(t),
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
  if (k.holdBand) {
    out.push({ holdBand: k.holdBand });
    out.push({ category: k.category, holdBand: k.holdBand });
    if (k.priceBand) out.push({ priceBand: k.priceBand, holdBand: k.holdBand });
  }
  return out;
}

type Agg = { n: number; staked: number; pnl: number; wins: number; rois: number[]; holds: number[] };

/** Fold one stream of settled trades into per-cell, per-window aggregates. */
function aggregate(trades: ScanTrade[], nowMs: number) {
  const byCell = new Map<string, { params: CellParams; windows: Map<string, Agg> }>();
  for (const t of trades) {
    if (t.realizedPnl == null) continue;
    const k = keysOf(t);
    if (HARD_EXCLUDED_CATEGORIES.has(k.category)) continue; // never copyable → never scanned
    const openedMs = t.openedAt instanceof Date ? t.openedAt.getTime() : t.openedAt;
    const stake = t.simulatedPositionSize || 0;
    const h = holdHours(t);
    for (const params of memberCells(k)) {
      const id = cellId(params);
      const entry = byCell.get(id) ?? { params, windows: new Map<string, Agg>() };
      for (const w of SCAN_WINDOWS) {
        if (w.ms !== null && openedMs < nowMs - w.ms) continue;
        const agg = entry.windows.get(w.key) ?? { n: 0, staked: 0, pnl: 0, wins: 0, rois: [], holds: [] };
        agg.n += 1;
        agg.staked += stake;
        agg.pnl += t.realizedPnl;
        if (t.realizedPnl > 0) agg.wins += 1;
        if (stake > 0) agg.rois.push(t.realizedPnl / stake);
        if (h !== null) agg.holds.push(h);
        entry.windows.set(w.key, agg);
      }
      byCell.set(id, entry);
    }
  }
  return byCell;
}

function windowStats(agg: Agg, cellsTested: number): WindowStats {
  const stats = edgeStats(agg.rois, cellsTested);
  const roi = agg.staked > 0 ? agg.pnl / agg.staked : 0;
  const avgHold = agg.holds.length > 0 ? mean(agg.holds) : null;
  const days = avgHold === null ? null : Math.max(avgHold, 1) / 24;
  return {
    n: agg.n,
    roi,
    winRate: agg.n > 0 ? agg.wins / agg.n : 0,
    pnl: Math.round(agg.pnl * 100) / 100,
    lcb: stats.lcb,
    strictLcb: stats.strictLcb,
    avgHoldHours: avgHold === null ? null : Math.round(avgHold * 100) / 100,
    roiPerDay: days === null || days <= 0 ? null : roi / days,
  };
}

/** Ranking key: the floor, never the headline. Unknown floors sort last. */
const rankOf = (s: CellScan) => s.windows.all.strictLcb ?? -Infinity;

export type ScanResult = {
  gold: CellScan[];
  traps: CellScan[];
  /**
   * Cells that qualify on COUNTERFACTUAL evidence only — signals we declined,
   * priced as if we had taken them. They never enter the strategy by themselves;
   * they are what the exploration budget aims at, so the cell can earn (or lose)
   * a verdict on real fills.
   */
  suspects: CellScan[];
  /**
   * Cells that had ENOUGH SAMPLE to be judged this scan — whether they passed or
   * failed. Absence of evidence is not evidence of absence: a cell nobody traded
   * has not failed anything, and striking it would prune the whole strategy
   * during any quiet stretch (exactly what a from-scratch restart looks like).
   */
  judged: Set<string>;
};

/**
 * Scan settled trades and return the surviving gold cells, trap cells and — from
 * the optional shadow stream — the suspicions worth exploring.
 *
 * Gold: n≥30, ROI ≥ +5%, ROI ≥ 0 in every window with n≥10, AND a lower bound
 * above zero. That last clause is what makes the standard sample-aware: it asks
 * roughly +22% at n=30 but only ~+6% at n=300, instead of a flat +5% that a
 * lucky fortnight can clear.
 * Trap: the mirror image (≤ −5%, ≤ 0 everywhere it has a sample, upper bound
 * still below zero).
 */
export function scanCells(trades: ScanTrade[], nowMs: number, shadow: ScanTrade[] = []): ScanResult {
  const realCells = aggregate(trades, nowMs);
  const cellsTested = realCells.size || 1;

  const gold: CellScan[] = [];
  const traps: CellScan[] = [];
  const judged = new Set<string>();
  for (const [id, entry] of realCells) {
    const all = entry.windows.get("all");
    if (!all || all.n < MIN_CELL_N || all.staked <= 0) continue;
    judged.add(id); // enough sample to be judged — pass or fail, it was tested
    const windows: Record<string, WindowStats> = {};
    for (const [wk, agg] of entry.windows) windows[wk] = windowStats(agg, cellsTested);

    const a = windows.all;
    const evidenced = Object.values(windows).filter((s) => s.n >= MIN_WINDOW_N);
    const scan: CellScan = { id, label: cellLabel(entry.params), params: entry.params, windows, source: "real" };
    if (a.roi >= MIN_GOLD_ROI && (a.lcb ?? -1) > 0 && evidenced.every((s) => s.roi >= 0)) gold.push(scan);
    else if (a.roi <= MAX_TRAP_ROI && evidenced.every((s) => s.roi <= 0)) {
      // Mirror of the bound: even generous assumptions leave it losing.
      const upper = a.lcb === null ? 0 : a.roi + (a.roi - a.lcb);
      if (upper < 0) traps.push(scan);
    }
  }

  // --- shadow stream: nominations only ---------------------------------------
  const suspects: CellScan[] = [];
  if (shadow.length > 0) {
    const shadowCells = aggregate(shadow, nowMs);
    const known = new Set([...gold.map((g) => g.id), ...traps.map((t) => t.id)]);
    const shadowTested = shadowCells.size || 1;
    for (const [id, entry] of shadowCells) {
      if (known.has(id)) continue; // real evidence already has the final word
      const all = entry.windows.get("all");
      if (!all || all.n < MIN_SHADOW_N || all.staked <= 0) continue;
      const windows: Record<string, WindowStats> = {};
      for (const [wk, agg] of entry.windows) windows[wk] = windowStats(agg, shadowTested);
      const a = windows.all;
      const evidenced = Object.values(windows).filter((s) => s.n >= MIN_WINDOW_N);
      if (a.roi >= MIN_GOLD_ROI && (a.lcb ?? -1) > 0 && evidenced.every((s) => s.roi >= 0)) {
        suspects.push({ id, label: cellLabel(entry.params), params: entry.params, windows, source: "shadow" });
      }
    }
  }

  gold.sort((a, b) => rankOf(b) - rankOf(a));
  traps.sort((a, b) => rankOf(a) - rankOf(b));
  suspects.sort((a, b) => rankOf(b) - rankOf(a));
  return { gold, traps, suspects, judged };
}

// ---------------------------------------------------------------------------
// Hysteresis — the pre-registered lifecycle
// ---------------------------------------------------------------------------

export type CellRow = {
  id: string;
  kind: CellKind;
  label: string;
  params: CellParams;
  /**
   * sospecha → candidata → activa → retirada.
   * "sospecha" is the shadow tier: nominated by counterfactuals, never copied by
   * the strategy, only ever reached by the exploration budget.
   */
  status: "sospecha" | "candidata" | "activa" | "retirada";
  hits: number;
  misses: number;
  windows: Record<string, WindowStats> | null;
  /** Which stream the CURRENT evidence came from. */
  evidenceSource: EvidenceSource;
  /** Settled REAL copies behind the cell — the only count that can activate it. */
  realN: number;
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
  scan: { gold: CellScan[]; traps: CellScan[]; suspects?: CellScan[]; judged?: Set<string> },
  nowMs: number,
): { rows: CellRow[]; events: CellEvent[] } {
  const rows = new Map(existing.map((r) => [r.id, { ...r }]));
  const events: CellEvent[] = [];
  const seen = new Set<string>();

  const fmt = (s: CellScan) => {
    const a = s.windows.all;
    const floor = a.strictLcb === null ? "s/d" : `${(a.strictLcb * 100).toFixed(1)}%`;
    return `ROI ${(a.roi * 100).toFixed(1)}% · piso ${floor} · n=${a.n} · 7d ${
      s.windows["7d"] ? `${(s.windows["7d"].roi * 100).toFixed(1)}% (n=${s.windows["7d"].n})` : "sin muestra"
    }`;
  };

  const activeGoldCount = () => [...rows.values()].filter((r) => r.kind === "gold" && r.status === "activa").length;

  const fold = (kind: CellKind, survivors: CellScan[]) => {
    for (const s of survivors) {
      seen.add(s.id);
      const shadow = s.source === "shadow";
      const prev = rows.get(s.id);
      if (!prev) {
        rows.set(s.id, {
          id: s.id,
          kind,
          label: s.label,
          params: s.params,
          status: shadow ? "sospecha" : "candidata",
          hits: 1,
          misses: 0,
          windows: s.windows,
          evidenceSource: s.source,
          realN: shadow ? 0 : s.windows.all.n,
          firstSeenAt: nowMs,
          activatedAt: null,
          retiredAt: null,
        });
        events.push({
          cellId: s.id,
          action: shadow ? "sospecha" : "candidata",
          detail: shadow
            ? `${s.label} — asomó en las señales que NO copiamos · ${fmt(s)} · hace falta llenado real para confirmarla`
            : `${s.label} — ${fmt(s)}`,
        });
        continue;
      }
      // A cell that survives can only be its own kind — a cell can't be gold
      // one day and trap the next without passing through failure first.
      prev.kind = kind;
      prev.hits += 1;
      prev.misses = 0;
      prev.windows = s.windows;
      prev.label = s.label;
      prev.evidenceSource = s.source;
      if (!shadow) {
        prev.realN = s.windows.all.n;
        // Real fills arrived for a cell the counterfactuals had only suspected:
        // it graduates out of the shadow tier and starts its real hysteresis.
        if (prev.status === "sospecha") {
          prev.status = "candidata";
          prev.hits = 1;
          events.push({
            cellId: s.id,
            action: "confirmada-real",
            detail: `${s.label} — la sospecha ya tiene copias reales detrás · ${fmt(s)}`,
          });
        }
      }
      // A shadow-only cell can never activate: counterfactual PnL pays no spread
      // and suffers no slippage, so acting on it would be trading on arithmetic.
      if (shadow || prev.status === "sospecha") continue;
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
  fold("gold", scan.suspects ?? []);

  // Cells that were TESTED this scan and did not survive: strike them.
  //
  // A cell with too little sample is NOT struck. Absence of evidence is not
  // evidence of absence: on a quiet stretch — or a restart from zero, where no
  // book has 30 settled trades yet — striking the unsampled would prune the
  // entire strategy in two cuts for no reason but silence. `judged` is omitted
  // by older callers, in which case the previous behaviour stands.
  const judged = scan.judged;
  for (const r of rows.values()) {
    if (seen.has(r.id) || r.status === "retirada") continue;
    if (judged && !judged.has(r.id)) continue; // no sample ⇒ no verdict
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

export type GoldVerdict = {
  gold: boolean;
  reason: string;
  ruleId?: string;
  /** True when the copy exists to LEARN about a cell, not because it is gold. */
  exploratory?: boolean;
};

export type VerdictInput = {
  arm: MatrixTrack;
  category: CategoryKey;
  hourInAppTz: number;
  entryPrice: number;
  /**
   * Deterministic 0–1 roll for the exploration budget (hash the signal id, never
   * Math.random — a verdict has to be reproducible from the journal).
   * Omit to disable exploration entirely.
   */
  exploreRoll?: number;
};

function matches(params: CellParams, input: VerdictInput, hourBlock: string, priceBand: string | null): boolean {
  if (params.arm && params.arm !== input.arm) return false;
  if (params.category && params.category !== input.category) return false;
  if (params.hourBlock && params.hourBlock !== hourBlock) return false;
  if (params.priceBand && params.priceBand !== priceBand) return false;
  // A cell pinned to a hold band can never be judged at entry: how long the
  // market takes to settle is not knowable yet. Those cells are for the scan,
  // not for the gate.
  if (params.holdBand) return false;
  return true;
}

/** Ranking key for attribution: the floor, falling back to ROI on old rows. */
const rowRank = (r: CellRow) => r.windows?.all?.strictLcb ?? r.windows?.all?.roi ?? 0;

/**
 * Is this trade in an ACTIVE gold cell (and no active trap cell)? Traps veto —
 * that is how e.g. "esports at night" stays out even though "esports ≤29¢" is
 * gold. Attribution goes to the matching gold cell with the best FLOOR, so the
 * /elite pruning board judges the best-evidenced claim, deterministically.
 *
 * When nothing is gold, a small budgeted share of signals landing in a SUSPECT
 * cell is copied anyway, flagged exploratory. Traps still veto those: exploring
 * is for the unknown, never for what we already know loses.
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
    .sort((a, b) => rowRank(b) - rowRank(a) || a.id.localeCompare(b.id));
  if (golds.length > 0) {
    const best = golds[0];
    return { gold: true, ruleId: best.id, reason: `celda de oro: ${best.label}` };
  }

  const miss = `no cae en ninguna celda de oro activa (${input.category}, h${input.hourInAppTz}, ${Math.round(input.entryPrice * 100)}¢)`;
  const roll = input.exploreRoll;
  if (roll === undefined || !(roll < EXPLORE_BUDGET)) return { gold: false, reason: miss };

  const suspects = active
    .filter((r) => r.kind === "gold" && r.status === "sospecha" && matches(r.params, input, hourBlock, priceBand))
    // Explore the LEAST known first: the cell with the fewest real fills is the
    // one where a copy buys the most information.
    .sort((a, b) => a.realN - b.realN || rowRank(b) - rowRank(a) || a.id.localeCompare(b.id));
  if (suspects.length === 0) return { gold: false, reason: miss };

  const pick = suspects[0];
  return {
    gold: true,
    ruleId: pick.id,
    exploratory: true,
    reason: `exploración (${Math.round(EXPLORE_BUDGET * 100)}% del presupuesto): sospecha sin llenado real — ${pick.label}`,
  };
}
