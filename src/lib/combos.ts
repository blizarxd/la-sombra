/**
 * 🧩 Combo book — pure logic (parsing, stats, settlement decisions).
 *
 * Polymarket "combos" (parlays) bundle 2-32 predictions into ONE trade that
 * only pays if every leg hits. The Combo Cup leaderboard surfaces the best
 * combo bettors; this module parses that leaderboard and reasons about combo
 * activity from the public data-api.
 *
 * Facts verified live on 2026-07-13:
 * - data-api /activity rows carry `isCombo: true` for combo TRADEs, with the
 *   combined price (e.g. 0.032 = 31x payout), the USDC stake, and the legs
 *   joined by " AND " in the title.
 * - A WON combo shows up as a REDEEM with the same (synthetic) conditionId and
 *   usdcSize = payout. Combo conditionIds are padded with a long run of
 *   trailing zeros — regular markets never look like that.
 * - There is NO public order book for combos (they trade via RFQ), so paper
 *   copies enter at the wallet's executed price and cannot be marked hourly.
 *
 * SAFETY: pure functions only. No network, no keys, no orders — ever.
 */

// ---------------------------------------------------------------------------
// Combo identification
// ---------------------------------------------------------------------------

/**
 * Combo conditionIds are synthetic: shorter hash + >=16 trailing zero chars.
 * A real market conditionId ending in 16 zeros has probability ~2^-64.
 */
export function isSyntheticComboConditionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^0x[0-9a-f]+0{16,}$/i.test(id);
}

/** Number of legs in a combo, from the " AND "-joined title. */
export function comboLegCount(title: string | null | undefined): number {
  if (!title) return 0;
  return title.split(" AND ").length;
}

// ---------------------------------------------------------------------------
// Wallet activity rows (data-api /activity, already fetched by the adapter)
// ---------------------------------------------------------------------------

export interface ComboActivityEvent {
  type: "TRADE" | "REDEEM";
  side: "BUY" | "SELL" | null; // REDEEMs have no side
  conditionId: string;
  isCombo: boolean;
  price: number; // combined combo price for TRADEs; 0 for REDEEMs
  usdcSize: number; // stake for TRADEs, payout for REDEEMs
  title: string | null;
  timestampMs: number;
  transactionHash: string | null;
}

/** Per-wallet combo scorecard over a lookback window (used for eligibility). */
export interface ComboWalletStats {
  buys: number;
  redeems: number; // count of winning combos redeemed
  staked: number; // USD put into combos
  redeemed: number; // USD paid out by winning combos
  soldBack: number; // USD recovered by cashing out (SELL)
  netPnl: number; // redeemed + soldBack - staked (honest, cashflow-based)
  /** Buys old enough that their legs should have resolved (>72h). */
  matureBuys: number;
  /** Redeems / matureBuys — biased young, labeled as an estimate in the UI. */
  estWinRate: number | null;
}

export function computeComboWalletStats(
  events: ComboActivityEvent[],
  nowMs: number,
  lookbackMs = 30 * 24 * 3600 * 1000,
): ComboWalletStats {
  const inWindow = events.filter((e) => e.isCombo && e.timestampMs >= nowMs - lookbackMs);
  let buys = 0;
  let staked = 0;
  let redeemed = 0;
  let soldBack = 0;
  let matureBuys = 0;
  let redeems = 0;
  for (const e of inWindow) {
    if (e.type === "TRADE" && e.side === "BUY") {
      buys++;
      staked += e.usdcSize;
      if (e.timestampMs < nowMs - 72 * 3600 * 1000) matureBuys++;
    } else if (e.type === "TRADE" && e.side === "SELL") {
      soldBack += e.usdcSize;
    } else if (e.type === "REDEEM") {
      redeems++;
      redeemed += e.usdcSize;
    }
  }
  return {
    buys,
    redeems,
    staked: round2(staked),
    redeemed: round2(redeemed),
    soldBack: round2(soldBack),
    netPnl: round2(redeemed + soldBack - staked),
    matureBuys,
    estWinRate: matureBuys > 0 ? Math.min(1, redeems / matureBuys) : null,
  };
}

// ---------------------------------------------------------------------------
// Settlement decision for an open paper combo
// ---------------------------------------------------------------------------

/** After this long without a redeem or cash-out we mark the combo as LOST.
 * Honest heuristic (there is no public resolution feed for combos): the book
 * copies short-dated sports combos, whose legs resolve within hours-days and
 * whose winners redeem fast. Labeled as a heuristic in the UI. */
export const COMBO_LOSS_TIMEOUT_MS = 7 * 24 * 3600 * 1000;

export type ComboSettlement =
  | { kind: "hold" }
  | { kind: "win"; payoutSeen: number }
  | { kind: "cashout"; price: number }
  | { kind: "loss_timeout" };

/**
 * Decide what happened to a copied combo by watching the SOURCE wallet's
 * later activity on the same conditionId:
 * - REDEEM  -> every leg hit; the combo WON (payout is deterministic: shares).
 * - SELL    -> the wallet cashed out early; we copy the exit at their price.
 * - nothing for COMBO_LOSS_TIMEOUT_MS -> assume a leg missed (labeled heuristic).
 */
export function decideComboSettlement(
  trade: { conditionId: string; openedAtMs: number },
  walletEvents: ComboActivityEvent[],
  nowMs: number,
): ComboSettlement {
  const after = walletEvents.filter(
    (e) => e.conditionId === trade.conditionId && e.timestampMs >= trade.openedAtMs - 60_000,
  );
  const redeem = after.find((e) => e.type === "REDEEM");
  if (redeem) return { kind: "win", payoutSeen: redeem.usdcSize };
  const sell = after.find((e) => e.type === "TRADE" && e.side === "SELL");
  if (sell && sell.price > 0) return { kind: "cashout", price: sell.price };
  if (nowMs - trade.openedAtMs > COMBO_LOSS_TIMEOUT_MS) return { kind: "loss_timeout" };
  return { kind: "hold" };
}

// ---------------------------------------------------------------------------
// Combo Cup leaderboard parsing (server-rendered HTML)
// ---------------------------------------------------------------------------

export interface ComboLeaderboardRow {
  rank: number;
  username: string; // display handle without "@"
  /** Wallet address when the profile href carries it; null -> resolve via profile page. */
  address: string | null;
  /** Profile path for username-only rows, e.g. "/@lancel777". */
  profilePath: string | null;
  legs: number | null;
  returnPct: number | null; // +4446 means +4,446%
  betUsd: number | null;
  payoutUsd: number | null;
}

/**
 * Extract a wallet address from a Polymarket profile href. Handles:
 * - "/profile/0xabc..." (direct)
 * - "/@0xabc...-1778312483347" (pseudonymous handle = address + timestamp)
 * - optional locale prefixes ("/es/@name")
 * Returns null for plain usernames (resolve those via the profile page).
 */
export function addressFromProfileHref(href: string): string | null {
  const direct = href.match(/\/profile\/(0x[0-9a-f]{40})/i);
  if (direct) return direct[1].toLowerCase();
  const pseudo = href.match(/\/@(0x[0-9a-f]{40})(?:-\d+)?(?:$|[/?#])/i);
  if (pseudo) return pseudo[1].toLowerCase();
  return null;
}

/** First proxyWallet address embedded in a profile page's HTML, or null. */
export function extractProxyWalletFromProfileHtml(html: string): string | null {
  const m = html.match(/proxyWallet\\?":\\?"(0x[0-9a-f]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

const num = (s: string): number | null => {
  const n = Number(s.replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the server-rendered Combo Cup leaderboard table. Anchored on the
 * `data-profile-link` anchor each row carries; tolerant of EN ("legs") and
 * ES ("selecciones") copies. Returns [] when the page shape changed — callers
 * must treat that as "scrape broken", log it and STOP (never fake data).
 */
export function parseComboLeaderboardHtml(html: string): ComboLeaderboardRow[] {
  const rows: ComboLeaderboardRow[] = [];
  const chunks = html.split(/<tr[\s>]/).slice(1);
  for (const chunk of chunks) {
    const link = chunk.match(/data-profile-link="true"[^>]*href="([^"]+)"/);
    if (!link) continue;
    const href = link[1];
    // Rank: the first cell's button text (falls back to position in the table).
    const rankM = chunk.match(/aria-label="View [^"]+combo"[^>]*>(\d+)</);
    // Handle: the visible "@Name" span (may be a bare 0xabcd…1234 shortening).
    const nameM = chunk.match(/>@?([^<@][^<]{0,60})<\/span><\/a>/);
    const legsM = chunk.match(/>(\d+)\s*(?:legs?|seleccion(?:es)?)</i);
    const pctM = chunk.match(/>([+-][\d,.]+)%</);
    const moneyM = chunk.match(/\$([\d,.]+)<span[^>]*>→<\/span><span[^>]*>\$([\d,.]+)</);
    const address = addressFromProfileHref(href);
    const username = (nameM?.[1] ?? "").trim().replace(/^@/, "");
    if (!address && !username) continue;
    rows.push({
      rank: rankM ? Number(rankM[1]) : rows.length + 1,
      username: username || (address ? address.slice(0, 10) : "?"),
      address,
      profilePath: address ? null : href.replace(/^\/[a-z]{2}\//, "/"),
      legs: legsM ? Number(legsM[1]) : null,
      returnPct: pctM ? num(pctM[1]) : null,
      betUsd: moneyM ? num(moneyM[1]) : null,
      payoutUsd: moneyM ? num(moneyM[2]) : null,
    });
  }
  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
