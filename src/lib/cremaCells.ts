import type { CategoryKey } from "./category";

/**
 * 🏆 La Crema — la ESTRATEGIA HÍBRIDA: el mejor oro de las matrices.
 *
 * Rebuilt 2026-07-18 (matrix cells instead of top-10 wallets), then re-derived
 * from scratch on 2026-07-20 against a FULL matrix scan — every cell of every
 * matrix, in all four windows (todo / 30d / 15d / 7d), keeping only what stays
 * positive in EVERY window with n≥30. Paper only: the real-money sample
 * (n=11-13) is far too small to steer a rule set, and the previous version of
 * this file leaned on it too hard.
 *
 * What the scan found, ranked by ROI with its sample:
 *
 *   MAÑANA 08–11 is the dominant signal in the entire dataset — gold in every
 *   arm at once: Pre-partido +21.6% (n=192), En Vivo +6.0% (n=458), La Crema
 *   +15.1% (n=84), esports +14.8% (n=270), and on four separate weekdays
 *   (lun +21.9% · mié +31.6% · vie +16.0% · dom +20.7%). Nothing else in the
 *   matrix repeats across that many independent cuts.
 *
 *   ESPORTS ≤29¢ +21.7% (n=89, 7d +24.6%) and ESPORTS EN MADRUGADA 00–03
 *   +20.3% (n=87) are the two standalone esports cells that survive every
 *   window. 30–44¢ esports did NOT survive (it flips negative in one), so the
 *   cheap cut is 29¢ — not the 44¢ of the previous version, and certainly not
 *   the 60¢ before that.
 *
 * DROPPED on this pass — both were mine, both were wrong:
 *   · TARDE 16–19, previously half the band rule: the scan shows tarde is NOT
 *     a consistent winner by arm (Cuota −12.5%, En Vivo +1.9%). Its only strong
 *     cell is "tarde × jueves" — a single weekday, almost certainly noise.
 *   · The standalone 60–89¢ band rule: 60–74¢ × Pre is +8.1% (n=293) but fades
 *     to +1.6% at 7d, and the genuinely golden part of it already sits inside
 *     the morning window that rule 1 now takes wholesale.
 *
 * Hard excludes: clima and cripto bleed in every arm and every window.
 */

const MORNING = [8, 11] as const; // 08–11 — the dominant window
const MADRUGADA = [0, 3] as const; // 00–03 — esports only
const NIGHT = [20, 23] as const; // 20–23 — esports turns red here
/**
 * Cheap-esports ceiling: 29¢ (exclusive at 0.30). That is the cell that
 * survives every window (+21.7%, 7d +24.6%). This threshold walked
 * 0.60 → 0.45 → 0.30 as each looser cut failed its own forward-test; the
 * 45–59¢ "coin flip" band in particular loses in paper AND in real money.
 */
const ESPORTS_CHEAP_MAX = 0.3; // exclusive

const EXCLUDED_CATEGORIES: ReadonlySet<CategoryKey> = new Set<CategoryKey>(["clima", "cripto"]);

const inWindow = (hour: number, [lo, hi]: readonly [number, number]) => hour >= lo && hour <= hi;

/** Which gold rule fired — stored on the trade so each cell is judged apart. */
export type CremaRule = "mañana" | "esports-barato" | "esports-madrugada";

export interface CremaVerdict {
  gold: boolean;
  reason: string;
  rule?: CremaRule;
}

/** When La Crema stopped being top-10-wallet driven and became matrix driven. */
export const CREMA_REBUILD_MS = Date.parse("2026-07-18T19:00:00Z"); // 15:00 Caracas

/**
 * Is this trade in a gold cell? Pure — the arms supply category (from the
 * market question), the open hour in APP_TZ, and the entry price.
 */
export function isCremaGoldCell(category: CategoryKey, hourInAppTz: number, entryPrice: number): CremaVerdict {
  if (EXCLUDED_CATEGORIES.has(category)) {
    return { gold: false, reason: `categoría ${category} excluida (roja en toda la matriz)` };
  }

  // Rule 1 — MAÑANA 08-11, cualquier categoría. El oro más repetido del sistema.
  if (inWindow(hourInAppTz, MORNING)) {
    return { gold: true, rule: "mañana", reason: `Mañana 08-11 (h${hourInAppTz}) — oro transversal en todos los brazos` };
  }

  // Rule 2 — ESPORTS ≤29¢, cualquier hora menos la noche.
  if (category === "esports" && entryPrice < ESPORTS_CHEAP_MAX && !inWindow(hourInAppTz, NIGHT)) {
    return {
      gold: true,
      rule: "esports-barato",
      reason: `esports ≤29¢ fuera de la noche (h${hourInAppTz}, ${Math.round(entryPrice * 100)}¢)`,
    };
  }

  // Rule 3 — ESPORTS en MADRUGADA 00-03, cualquier banda.
  if (category === "esports" && inWindow(hourInAppTz, MADRUGADA)) {
    return { gold: true, rule: "esports-madrugada", reason: `esports en Madrugada 00-03 (h${hourInAppTz})` };
  }

  return { gold: false, reason: `no es celda de oro (${category}, h${hourInAppTz}, ${Math.round(entryPrice * 100)}¢)` };
}
