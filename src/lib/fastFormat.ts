/**
 * ⚡ FAST-FORMAT classifier — a text-only proxy for "resolves within ~1h".
 *
 * The original plan used Polymarket's `end_date` (via `expectedResolutionHours`
 * in fastBook.ts) as the entry-time predictor. In production it turned out to
 * be useless for this: only ~15% of copies had it at all, and most of THOSE
 * were nonsensical — negative (the "scheduled end" already 19h in the past for
 * live in-play props) or absurdly large (148h for a multi-day tournament
 * bracket). `end_date` evidently does not reliably mean "when THIS proposition
 * resolves" across Polymarket's market types.
 *
 * This replaces it with a pattern match on the market QUESTION TEXT, which is
 * available on 100% of copies. It is deliberately conservative: only formats
 * with a real, checkable reason to resolve fast are matched. A full-match
 * moneyline or an overall best-of-3 SERIES winner is NOT matched even though
 * it is esports/deportes, because those genuinely take hours — matching them
 * would dilute the exact edge /matriz found, not extend it.
 */

const ESPORTS_SUB_MAP = /\b(map|game)\s*\d+(\s*winner)?\b/i;

const DEPORTES_SPLIT_PERIOD =
  /\b((at\s+)?half-?time|(1st|first|2nd|second)\s+half|q[1-4]\b|quarter\s*[1-4]|(1st|first|2nd|second|3rd|third)\s+(period|quarter|set))\b/i;

/**
 * True when the market's own format gives it a real shot at resolving within
 * roughly an hour: a single map/game inside a series (not the series itself),
 * or a split-period sports prop (half, quarter, period) rather than the
 * full-match outcome.
 */
export function isFastFormatMarket(question: string | null | undefined): boolean {
  if (!question) return false;
  const q = question.split(" AND ")[0]; // first leg for combos, same convention as categorizeMarket
  return ESPORTS_SUB_MAP.test(q) || DEPORTES_SPLIT_PERIOD.test(q);
}
