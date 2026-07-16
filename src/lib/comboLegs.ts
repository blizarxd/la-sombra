/**
 * Leg-based combo settlement (added 2026-07-16).
 *
 * Combos have NO public market: their synthetic conditionIds (note the zero
 * padding) are unknown to gamma and the CLOB, they never show up in the
 * holder's /positions, and no dedicated combo API exists (all probed live
 * 2026-07-16). So a lost combo used to sit "open" until a 7-day timeout —
 * with a 15-slot book, dead losers parked the capital and starved new copies.
 *
 * What IS public: every LEG of a combo is a real market. The combo title
 * lists the legs joined by " AND " ("Will Argentina win on 2026-07-15? AND
 * Will Spain win on 2026-07-14?"), and gamma's public-search resolves a leg
 * question to its market, whose umaResolutionStatus/outcomePrices are
 * authoritative. A parlay needs EVERY leg to hit, so one leg resolved
 * against the pick kills the whole combo — that is a deterministic LOSS,
 * available within hours instead of 7 days.
 *
 * The one assumption, stated honestly everywhere this fires: the bettor took
 * the AFFIRMATIVE side of each leg as titled (Yes on "Will X win…?"). That is
 * the overwhelming combo convention (you parlay teams TO WIN), but it is an
 * assumption, so verdicts carry the "patas" label just like the timeout
 * carries its own. Legs whose side can't be read this way (O/U without a
 * side, spreads) are simply skipped — they can prove nothing either way.
 * WINS are never decided from legs: the REDEEM event stays the only win
 * proof (it is deterministic and carries the real payout).
 */

/** Split a combo title into its leg questions. */
export function splitComboLegs(title: string | null | undefined): string[] {
  if (!title) return [];
  return title
    .split(/\sAND\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A leg whose affirmative side is unambiguous from its question text alone:
 * "Will … ?" Yes/No markets. Spread/O-U legs return false — their titled
 * form doesn't say which side the bettor took, so they must not be judged.
 */
export function isAffirmativeLeg(leg: string): boolean {
  return /^will\s.+\?$/i.test(leg.trim());
}

export type LegOutcome = "won" | "lost" | "open" | "unknown";

/**
 * Judge one leg against its resolved gamma market. `outcomes` and
 * `outcomePrices` are gamma's JSON-encoded arrays (e.g. '["Yes","No"]',
 * '["0","1"]'). Only a market that is closed AND uma-resolved is judged —
 * a live price of 0.001 is still an open market, not a verdict.
 */
export function judgeAffirmativeLeg(market: {
  question?: string | null;
  closed?: boolean | null;
  umaResolutionStatus?: string | null;
  outcomes?: string | null;
  outcomePrices?: string | null;
}): LegOutcome {
  if (!market.closed || market.umaResolutionStatus !== "resolved") return "open";
  let outcomes: unknown;
  let prices: unknown;
  try {
    outcomes = JSON.parse(market.outcomes ?? "null");
    prices = JSON.parse(market.outcomePrices ?? "null");
  } catch {
    return "unknown";
  }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== prices.length) return "unknown";
  const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
  if (yesIdx === -1) return "unknown";
  const yesPrice = Number(prices[yesIdx]);
  if (yesPrice === 1) return "won";
  if (yesPrice === 0) return "lost";
  return "unknown"; // partial/odd resolution — never guess
}
