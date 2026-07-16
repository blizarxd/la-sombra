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

/**
 * How long to wait for a REDEEM after a combo's LAST leg resolved before
 * calling it a loss.
 *
 * MEASURED, not guessed (2026-07-16, Combo Cup wallets' public activity):
 *   - 4 redeemed combos: the wallet claimed +2.4h, +2.7h, +2.8h and +3.6h
 *     after the last leg resolved. Winners claim fast and consistently.
 *   - 6 combos with EVERY leg resolved and no claim at all, aged 22h, 116h,
 *     116h, 233h, 257h and 304h. Losers never claim, ever.
 * A 12h grace is ~3.3x the slowest observed claim, and every unclaimed loser
 * was already well past it. Still a heuristic — labeled as such — but one
 * with a measured gap between the two populations instead of a round number.
 */
export const REDEEM_GRACE_MS = 12 * 3600 * 1000;

export type ComboLegVerdict =
  /** A leg we can read resolved AGAINST the pick — the parlay is dead. */
  | { kind: "lost_leg"; leg: string }
  /** Every leg resolved and the wallet never claimed past the grace window. */
  | { kind: "lost_unclaimed"; hoursSinceResolved: number }
  /** Not decidable yet (a leg still open, or legs we cannot read). */
  | { kind: "hold"; allLegsResolved: boolean };

export interface LegState {
  question: string;
  /** null when the leg could not be resolved to a market at all. */
  resolved: boolean | null;
  endDateMs: number | null;
  /** Only meaningful for affirmative ("Will …?") legs; "unknown" otherwise. */
  outcome: LegOutcome;
}

/**
 * Decide a combo's fate from its legs alone (no redeem/sell seen).
 *
 * Only ever returns a LOSS. A win is never inferred here: REDEEM is the only
 * proof of a win, and it carries the real payout. This deliberately replaces
 * the old flat "7 days since the BUY" timeout, which was wrong in both
 * directions — it waited a week on combos whose games finished yesterday, and
 * it killed combos whose last leg was still 10 days out.
 */
export function decideComboByLegs(legs: LegState[], nowMs: number): ComboLegVerdict {
  const lost = legs.find((l) => l.outcome === "lost");
  if (lost) return { kind: "lost_leg", leg: lost.question };

  const allLegsResolved = legs.length > 0 && legs.every((l) => l.resolved === true);
  if (!allLegsResolved) return { kind: "hold", allLegsResolved: false };

  // Every leg is settled. Winners claim within hours (see REDEEM_GRACE_MS);
  // if nothing was claimed past the grace, the parlay missed.
  const ends = legs.map((l) => l.endDateMs).filter((e): e is number => e != null);
  if (ends.length === 0) return { kind: "hold", allLegsResolved: true }; // resolved but undatable — don't guess
  const lastEnd = Math.max(...ends);
  if (nowMs - lastEnd <= REDEEM_GRACE_MS) return { kind: "hold", allLegsResolved: true };
  return { kind: "lost_unclaimed", hoursSinceResolved: (nowMs - lastEnd) / 3600_000 };
}

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
