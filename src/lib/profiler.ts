import type { MarketInfo, WalletTrade } from "./adapters/types";
import type { Rules } from "./rules";
import { scoreWallet, statusForScore, type ResolvedTradeLike, type WalletScoreResult } from "./scoring/walletScoring";

/**
 * Wallet profiler: turns raw trade history + market metadata into the
 * metrics stored on wallet_profiles. Pure — scripts do the fetching.
 */

export interface WalletProfileMetrics {
  roi30d: number | null;
  tradeCount30d: number;
  resolvedTradeCount30d: number;
  winRate30d: number | null;
  averageTradeSize: number | null;
  averageLiquidity: number | null;
  averageSpread: number | null;
  averageEntryTiming: number | null;
  score: WalletScoreResult;
  status: "track" | "watch" | "ignore";
  resolvedTrades: ResolvedTradeLike[];
}

export function buildResolvedTrades(
  trades: WalletTrade[],
  markets: Map<string, MarketInfo>,
): ResolvedTradeLike[] {
  const resolved: ResolvedTradeLike[] = [];
  for (const t of trades) {
    if (t.side !== "BUY" || t.price <= 0) continue;
    const market = t.conditionId ? markets.get(t.conditionId) : undefined;
    if (!market || !market.resolved || market.winningOutcomeIndex === null) continue;
    const winnerName = market.outcomes[market.winningOutcomeIndex];
    let won: boolean | null = null;
    if (t.outcome && winnerName) {
      won = t.outcome.toLowerCase() === winnerName.toLowerCase();
    } else if (t.tokenId && market.clobTokenIds.length) {
      const idx = market.clobTokenIds.indexOf(t.tokenId);
      if (idx >= 0) won = idx === market.winningOutcomeIndex;
    }
    if (won === null) continue;
    const shares = t.sizeUsd / t.price;
    const pnl = won ? shares * 1 - t.sizeUsd : -t.sizeUsd;
    resolved.push({
      pnl,
      category: market.category ?? t.marketCategory ?? null,
      timestampMs: t.timestampMs,
      liquidity: market.liquidity,
      spread: null, // historical spread unknown; scored neutrally
      entryDrift: null, // measured live once we track the wallet
      entryPrice: t.price,
      sizeUsd: t.sizeUsd,
    });
  }
  return resolved;
}

export function profileWallet(
  trades: WalletTrade[],
  markets: Map<string, MarketInfo>,
  rules: Rules,
  leaderboardRoi?: number | null,
): WalletProfileMetrics {
  const resolvedTrades = buildResolvedTrades(trades, markets);
  const buys = trades.filter((t) => t.side === "BUY");

  const totalCost = resolvedTrades.reduce((a, t) => a + t.sizeUsd, 0);
  const totalPnl = resolvedTrades.reduce((a, t) => a + t.pnl, 0);
  const computedRoi = totalCost > 0 ? totalPnl / totalCost : null;
  const roi30d = leaderboardRoi ?? computedRoi;

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const liqs = resolvedTrades.map((t) => t.liquidity).filter((x): x is number => x !== null);

  const score = scoreWallet({ roi30d, resolvedTrades, tradeCount30d: trades.length }, rules);

  return {
    roi30d,
    tradeCount30d: trades.length,
    resolvedTradeCount30d: resolvedTrades.length,
    winRate30d: score.winRate,
    averageTradeSize: avg(buys.map((t) => t.sizeUsd)),
    averageLiquidity: avg(liqs),
    averageSpread: null,
    averageEntryTiming: null,
    score,
    status: statusForScore(score.globalScore, rules),
    resolvedTrades,
  };
}
