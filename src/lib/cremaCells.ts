import type { CategoryKey } from "./category";

/**
 * 🏆 La Crema — GOLD-CELL gate (rebuilt 2026-07-18).
 *
 * The old La Crema mirrored an arm's copy when the SOURCE WALLET was a top-10
 * weekly winner of that arm. It failed hard (-$137 realized, 37% win, 87
 * settled): a wallet can be "top-10 this week" and still bet in a losing slot,
 * so the roster carried the arm's bad cells straight into La Crema.
 *
 * New design, per Johan: the filter is the MATRIX CELL, not the wallet. La
 * Crema still mirrors what the arms already decided to copy — it invents no
 * entry of its own — but it only keeps the copy when the trade lands in a cell
 * the matrix has proven gold ACROSS MULTIPLE cuts. That turns La Crema into a
 * clean experiment: if "gold cells only, any arm" goes green while the arms
 * themselves bleed, the matrix thesis is proven with a real ledger.
 *
 * STRICT on purpose — La Crema is "lo mejor de lo mejor", so this is the
 * high-conviction intersection, not every green cell:
 *
 *   1. ESPORTS, any hour EXCEPT night (20–23).
 *      Esports is the one edge that repeats in every cut: green in pre (+7.2%),
 *      live (+6.0%), cuota (+9.5%) and in nearly every band and hour — the only
 *      slot it turns red is night (20–23: −21.4%). So esports is gold all day
 *      but night. (This deliberately KEEPS esports at midday, +15.2% n121 —
 *      midday is bad for sports, not for esports.)
 *
 *   2. HIGH BAND 60–89¢ in MORNING (08–11) or TARDE (16–19).
 *      The high bands are green across arms (pre 60–74¢ +10.9%/70% wins,
 *      deportes 75–89¢ +10.6%/83% wins) AND morning/tarde are the two green
 *      windows (deportes morning +15.3%, tarde +8.6%). Their intersection is
 *      the sweet spot for everything that isn't esports.
 *
 * Hard excludes (never gold, even if a rule above would match):
 *   - Category clima (−38% live) and cripto (−11% cuota) — both bleed everywhere.
 *
 * Everything else — low bands outside esports, midday sports, dawn, night —
 * is left to the arms; La Crema does not touch it.
 */

const BAND_LO = 0.6; // inclusive
const BAND_HI = 0.9; // exclusive
const MORNING = [8, 11] as const; // 08–11
const TARDE = [16, 19] as const; // 16–19
const NIGHT = [20, 23] as const; // 20–23

const EXCLUDED_CATEGORIES: ReadonlySet<CategoryKey> = new Set<CategoryKey>(["clima", "cripto"]);

const inWindow = (hour: number, [lo, hi]: readonly [number, number]) => hour >= lo && hour <= hi;

export interface CremaVerdict {
  gold: boolean;
  reason: string;
}

/**
 * Is this trade in a La Crema gold cell? Pure — the arms supply category
 * (from the market question), the open hour in APP_TZ, and the entry price.
 */
export function isCremaGoldCell(category: CategoryKey, hourInAppTz: number, entryPrice: number): CremaVerdict {
  if (EXCLUDED_CATEGORIES.has(category)) {
    return { gold: false, reason: `categoría ${category} excluida (roja en toda la matriz)` };
  }

  // Rule 1 — esports, all day but night.
  if (category === "esports" && !inWindow(hourInAppTz, NIGHT)) {
    return { gold: true, reason: `esports fuera de la noche (h${hourInAppTz}) — verde transversal` };
  }

  // Rule 2 — high band in the two green windows.
  const highBand = entryPrice >= BAND_LO && entryPrice < BAND_HI;
  const greenWindow = inWindow(hourInAppTz, MORNING) || inWindow(hourInAppTz, TARDE);
  if (highBand && greenWindow) {
    const win = inWindow(hourInAppTz, MORNING) ? "Mañana 08-11" : "Tarde 16-19";
    return { gold: true, reason: `banda ${Math.round(entryPrice * 100)}¢ en ${win} — celda de oro` };
  }

  return { gold: false, reason: `no es celda de oro (${category}, h${hourInAppTz}, ${Math.round(entryPrice * 100)}¢)` };
}
