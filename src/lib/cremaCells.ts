import type { Db } from "@/db/client";
import { cremaCells } from "@/db/schema";
import type { CategoryKey } from "./category";
import {
  cellLabel,
  parseCellId,
  verdictFromCells,
  type CellParams,
  type CellRow,
  type GoldVerdict,
  type VerdictInput,
  type WindowStats,
} from "./goldEngine";
import type { MatrixTrack } from "./slices";

/**
 * 🏆 La Crema — la ESTRATEGIA HÍBRIDA: el mejor oro de las matrices.
 *
 * Rebuilt 2026-07-18 (matrix cells instead of top-10 wallets), re-derived from
 * a full manual matrix scan on 2026-07-20, and made SELF-EVOLVING later that
 * same day: the gold cells now live in the `crema_cells` table, re-derived
 * every daily cut by derive-crema-cells.ts with the pre-registered hysteresis
 * in goldEngine.ts (2 scans to activate, 2 failing scans to prune). This file
 * keeps only the SEEDS — the manually-scanned 2026-07-20 rule set — used to
 * bootstrap the table on first run and as a fallback if it is ever empty.
 *
 * Paper only. The real-money sample (n=11-13) stays out of the derivation on
 * purpose: far too small to steer a rule set.
 */

/** When La Crema stopped being top-10-wallet driven and became matrix driven. */
export const CREMA_REBUILD_MS = Date.parse("2026-07-18T19:00:00Z"); // 15:00 Caracas

/**
 * The 2026-07-20 manual scan, expressed as engine cells. Gold + one trap:
 *   · hour:08 — Mañana 08-11, any category (the transversal gold)
 *   · cat-band:esports:p00 — esports ≤29¢ (+21.7%, n=89)
 *   · cat-hour:esports:00 — esports en Madrugada 00-03 (+20.3%, n=87)
 *   · TRAP cat-hour:esports:20 — esports at night, the one stretch where
 *     esports turns red (this is the old "fuera de la noche" clause, now a veto)
 */
export const SEED_GOLD_IDS = ["hour:08", "cat-band:esports:p00", "cat-hour:esports:00"] as const;
export const SEED_TRAP_IDS = ["cat-hour:esports:20"] as const;

function seedRow(id: string, kind: "gold" | "trap"): CellRow {
  const params = parseCellId(id);
  if (!params) throw new Error(`bad seed cell id: ${id}`);
  return {
    id,
    kind,
    label: cellLabel(params),
    params,
    status: "activa",
    hits: 2,
    misses: 0,
    windows: null,
    // The seeds came from a scan of REAL settled copies (the manual 2026-07-20
    // sweep), so they start on the real tier — the shadow stream did not exist yet.
    evidenceSource: "real",
    realN: 0, // unknown from the frozen scan; the first live scan fills it in
    firstSeenAt: CREMA_REBUILD_MS,
    activatedAt: CREMA_REBUILD_MS,
    retiredAt: null,
  };
}

export function seedCells(): CellRow[] {
  return [...SEED_GOLD_IDS.map((id) => seedRow(id, "gold")), ...SEED_TRAP_IDS.map((id) => seedRow(id, "trap"))];
}

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

export type StoredCell = CellRow & { fromSeed: boolean };

function rowFromDb(r: typeof cremaCells.$inferSelect): CellRow {
  let params: CellParams = {};
  let windows: Record<string, WindowStats> | null = null;
  try {
    params = JSON.parse(r.paramsJson) as CellParams;
  } catch {
    params = parseCellId(r.id) ?? {};
  }
  try {
    windows = r.evidenceJson ? (JSON.parse(r.evidenceJson) as Record<string, WindowStats>) : null;
  } catch {
    windows = null;
  }
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    params,
    status: r.status,
    hits: r.hits,
    misses: r.misses,
    windows,
    evidenceSource: r.evidenceSource,
    realN: r.realN,
    firstSeenAt: r.firstSeenAt.getTime(),
    activatedAt: r.activatedAt?.getTime() ?? null,
    retiredAt: r.retiredAt?.getTime() ?? null,
  };
}

/** Every tracked cell (all statuses), for the /elite overview. */
export function loadAllCells(db: Db): CellRow[] {
  return db.select().from(cremaCells).all().map(rowFromDb);
}

/**
 * The ACTIVE rule set. Seeds apply ONLY when the table has never been seeded
 * (fresh deploy before the first derive run). If the table HAS rows but none
 * are active — i.e. the scan legitimately pruned everything — the hybrid gets
 * an EMPTY set and simply stops copying: "no confirmed gold right now" is an
 * honest answer, silently resurrecting pruned rules is not.
 */
export function loadActiveCells(db: Db): { cells: CellRow[]; fromSeed: boolean } {
  try {
    const rows = db.select().from(cremaCells).all().map(rowFromDb);
    // "sospecha" rows travel with the active set on purpose: they never produce
    // a gold verdict, but the exploration budget needs to see them to aim at.
    if (rows.length > 0) {
      return { cells: rows.filter((r) => r.status === "activa" || r.status === "sospecha"), fromSeed: false };
    }
  } catch {
    // table missing (pre-migration) — fall through to seeds
  }
  return { cells: seedCells(), fromSeed: true };
}

/**
 * Deterministic 0–1 roll for the exploration budget, derived from the signal's
 * own id. Never Math.random: the same signal must always get the same verdict,
 * so a decision can be re-derived from the journal months later.
 */
export function exploreRollFor(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** The verdict score-trades asks for on every arm copy. */
export function cremaVerdict(
  db: Db,
  input: {
    arm: MatrixTrack;
    category: CategoryKey;
    hourInAppTz: number;
    entryPrice: number;
    /** Signal id; presence of this is what enables exploration for the call. */
    exploreSeed?: string;
  },
): GoldVerdict {
  const { exploreSeed, ...rest } = input;
  return verdictFromCells(loadActiveCells(db).cells, {
    ...rest,
    exploreRoll: exploreSeed === undefined ? undefined : exploreRollFor(exploreSeed),
  } as VerdictInput);
}

// ---------------------------------------------------------------------------
// Labels & continuity
// ---------------------------------------------------------------------------

/**
 * Older Crema copies were stamped with human rule names before cell ids
 * existed. Map them onto their canonical cell so the pruning board shows ONE
 * row per cell across both eras.
 */
const LEGACY_RULE_TO_CELL: Record<string, string> = {
  "mañana": "hour:08",
  "esports-barato": "cat-band:esports:p00",
  "esports-madrugada": "cat-hour:esports:00",
};

export function canonicalGoldRule(rule: string): string {
  return LEGACY_RULE_TO_CELL[rule] ?? rule;
}

/** Retired/legacy stamps that are not cell ids get an honest label. */
const SPECIAL_LABELS: Record<string, string> = {
  "banda-ventana": "⚠️ banda-ventana (regla retirada 20-jul, ya no entra)",
  "regla-v1": "⚠️ regla-v1 (copias del arranque, sin celda atribuible)",
};

export function goldRuleLabel(rule: string): string {
  const canonical = canonicalGoldRule(rule);
  const special = SPECIAL_LABELS[canonical];
  if (special) return special;
  const params = parseCellId(canonical);
  return params ? cellLabel(params) : `⚠️ ${canonical}`;
}
