/**
 * 🏆 Elite roster ("la crema") — pure ranking logic.
 *
 * Not a strategy: it has no entry rules of its own. It selects, per arm
 * (core/live/trade/crypto), the top wallets by REALIZED paper PnL over the
 * trailing week — "verdes confirmados" (confirmed winners), never a wallet
 * currently in the red. Scripts do the DB I/O; this module just ranks.
 */

export const ELITE_ROSTER_SIZE = 10;
export const ELITE_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
export const ELITE_POSITION_SIZE = 5; // USD, fixed — same floor as trade/crypto/combo

export interface EliteRosterEntry {
  walletAddress: string;
  rank: number; // 1 = best this week
  weeklyPnl: number;
  weeklyTradeCount: number;
}

/**
 * Rank wallets by trailing-week realized PnL and keep the top N — but ONLY
 * confirmed winners (pnl > 0). A wallet having a bad week simply falls off
 * the roster rather than ever being "the least-bad negative wallet."
 */
export function rankEliteRoster(
  perWallet: Map<string, { pnl: number; n: number }>,
  size: number = ELITE_ROSTER_SIZE,
): EliteRosterEntry[] {
  return [...perWallet.entries()]
    .filter(([, v]) => v.pnl > 0)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, size)
    .map(([walletAddress, v], i) => ({
      walletAddress,
      rank: i + 1,
      weeklyPnl: Math.round(v.pnl * 100) / 100,
      weeklyTradeCount: v.n,
    }));
}
