import type { CategoryKey } from "./category";
import type { RuleScope } from "./rules";

/**
 * Per-category entry-price floor overrides — so a book-wide minEntryPrice bump
 * never blindly clobbers a category that wins at a DIFFERENT price than the
 * book's average. Evidence lives in /matriz (categoría × banda de entrada,
 * per book): Core's edge is concentrated at 60–74¢+ in ⚽ Deportes (ROI 14.8%,
 * n=105, 70% aciertos) while 45–59¢ is a loser there (ROI -2.0%, n=166); the
 * 2026-07-15 AI cut independently confirmed the same 60–74¢ pattern.
 *
 * Deliberately narrow: only (scope, category) pairs with a well-sampled,
 * same-direction finding get an override. Esports is NOT overridden here even
 * though it shows a cheap sweet spot (45–59¢) in the combined category×band
 * view — that finding is driven mostly by the live book (esports-in-core has
 * only ~15 settled trades, too thin to act on). Everything else falls back to
 * the scope's global minEntryPrice, unchanged.
 */
const OVERRIDES: Partial<Record<RuleScope, Partial<Record<CategoryKey, number>>>> = {
  core: {
    deportes: 0.6,
  },
};

/**
 * The floor to apply for this (scope, category): the override if one exists
 * and is stricter than the book's own global floor, else the global floor
 * unchanged. Never LOOSENS the global floor — an override only tightens.
 */
export function effectiveMinEntryPrice(scope: RuleScope, category: CategoryKey, globalMinEntryPrice: number): number {
  const override = OVERRIDES[scope]?.[category];
  return override != null ? Math.max(override, globalMinEntryPrice) : globalMinEntryPrice;
}

/**
 * Whole categories a book should NOT copy at all — the bleed isn't the price,
 * it's that the category itself is unpredictable for that book, so no entry
 * floor can save it. Evidence per (scope, category) in /matriz (categoría ×
 * brazo), same discipline as the floors: only well-sampled, clearly-losing
 * cells get excluded.
 *
 * live/clima: weather markets ("highest temp in London = 28°C?") are near-random
 *   in-play — En Vivo went 13% win, ROI -55.3% over n=8. No price band fixes a
 *   coin-flip on the weather, so live simply stops copying them. (2026-07-15.)
 */
const EXCLUSIONS: Partial<Record<RuleScope, ReadonlySet<CategoryKey>>> = {
  live: new Set<CategoryKey>(["clima"]),
};

/** True if this book should skip the whole category regardless of price. */
export function isCategoryExcluded(scope: RuleScope, category: CategoryKey): boolean {
  return EXCLUSIONS[scope]?.has(category) ?? false;
}
