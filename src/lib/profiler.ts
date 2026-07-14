import { isInPlayTrade } from "./adapters/types";
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
  liveTradeCount30d: number;
  liveResolvedCount30d: number;
  liveWinRate30d: number | null;
  liveRoi30d: number | null;
  swing: SwingStats;
  score: WalletScoreResult;
  status: "track" | "watch" | "ignore";
  resolvedTrades: ResolvedTradeLike[];
}

// --- quota-trader (swing) profiling -----------------------------------------

export interface SwingStats {
  sellCount: number; // raw SELL trades seen
  matchedExitCount: number; // SELLs matched against a prior BUY (real swings)
  swingPnl: number; // realized USD PnL from matched buy->sell pairs
  swingWinRate: number | null; // share of matched exits with positive PnL
  earlyExitRate: number | null; // matched sold shares / total bought shares
  style: "holdea" | "mixto" | "tradea_cuota";
}

/**
 * FIFO-match SELLs against earlier BUYs on the same market/outcome to measure
 * whether a wallet trades the odds (sells positions early) instead of holding
 * to resolution — and whether that swing trading actually makes money.
 */
export function buildSwingStats(trades: WalletTrade[]): SwingStats {
  const sorted = [...trades].sort((a, b) => a.timestampMs - b.timestampMs);
  const lots = new Map<string, { price: number; shares: number }[]>();
  let totalBoughtShares = 0;
  let totalMatchedShares = 0;
  let swingPnl = 0;
  let sellCount = 0;
  let matchedExitCount = 0;
  let winningExits = 0;

  for (const t of sorted) {
    if (t.price <= 0) continue;
    const key = `${t.marketId}|${t.tokenId ?? t.outcome ?? ""}`;
    const shares = t.sizeUsd / t.price;
    if (t.side === "BUY") {
      const queue = lots.get(key) ?? [];
      queue.push({ price: t.price, shares });
      lots.set(key, queue);
      totalBoughtShares += shares;
    } else {
      sellCount++;
      const queue = lots.get(key);
      if (!queue || queue.length === 0) continue; // sold something we never saw bought
      let remaining = shares;
      let exitPnl = 0;
      let matched = 0;
      while (remaining > 1e-9 && queue.length > 0) {
        const lot = queue[0];
        const take = Math.min(remaining, lot.shares);
        exitPnl += take * (t.price - lot.price);
        lot.shares -= take;
        remaining -= take;
        matched += take;
        if (lot.shares <= 1e-9) queue.shift();
      }
      if (matched > 1e-9) {
        matchedExitCount++;
        swingPnl += exitPnl;
        totalMatchedShares += matched;
        if (exitPnl > 0) winningExits++;
      }
    }
  }

  const earlyExitRate = totalBoughtShares > 0 ? totalMatchedShares / totalBoughtShares : null;
  const style: SwingStats["style"] =
    earlyExitRate === null || earlyExitRate < 0.15
      ? "holdea"
      : earlyExitRate < 0.5
        ? "mixto"
        : "tradea_cuota";
  return {
    sellCount,
    matchedExitCount,
    swingPnl,
    swingWinRate: matchedExitCount > 0 ? winningExits / matchedExitCount : null,
    earlyExitRate,
    style,
  };
}

/**
 * Eligibility for the 🔁 Trade book. Judged on the wallet's SWING record, NOT
 * its hold-to-resolution leaderboard score (that score is a holder metric and
 * was filtering every scalper out before this gate mattered). A wallet earns
 * the trade book when it trades the odds (sells early) with a real, profitable
 * track record: enough matched exits, a winning swing win-rate, positive swing
 * PnL. Pure so the copy gate is testable.
 */
export const MIN_SWING_EXITS = 3;
export const MIN_SWING_WIN_RATE = 0.5;

export function isQuotaTraderEligible(w: {
  tradingStyle: string | null;
  swingPnl30d: number | null;
  swingWinRate30d: number | null;
  sellCount30d: number | null;
}): boolean {
  const tradesOdds = w.tradingStyle === "tradea_cuota" || w.tradingStyle === "mixto";
  const enoughExits = (w.sellCount30d ?? 0) >= MIN_SWING_EXITS;
  const winsSwings = (w.swingWinRate30d ?? 0) >= MIN_SWING_WIN_RATE;
  const profitable = (w.swingPnl30d ?? 0) > 0;
  return tradesOdds && enoughExits && winsSwings && profitable;
}

/**
 * Eligibility for the ₿ Crypto book. EITHER a proven holder (score >= the
 * book's own gate) OR a proven quota-trader (swing record) qualifies — fixed
 * 2026-07-14 after verifying live that a pure holder-score gate filtered out
 * 27 of 29 tracked crypto wallets: fast BTC/ETH Up-or-Down markets (~15min)
 * mostly get round-tripped, not held to resolution, so the holder-score-only
 * gate rejected exactly the wallets the crypto sourcing exists to find.
 */
export function isCryptoBookEligible(
  w: {
    globalScore: number | null;
    tradingStyle: string | null;
    swingPnl30d: number | null;
    swingWinRate30d: number | null;
    sellCount30d: number | null;
  },
  minGlobalScore: number,
): boolean {
  return (w.globalScore ?? 0) >= minGlobalScore || isQuotaTraderEligible(w);
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
      inPlay: isInPlayTrade(t.timestampMs, market),
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

  // --- in-play (live betting) sub-metrics ---
  const liveBuys = buys.filter((t) =>
    isInPlayTrade(t.timestampMs, t.conditionId ? markets.get(t.conditionId) : undefined),
  );
  const liveResolved = resolvedTrades.filter((t) => t.inPlay);
  const liveWins = liveResolved.filter((t) => t.pnl > 0).length;
  const liveCost = liveResolved.reduce((a, t) => a + t.sizeUsd, 0);
  const livePnl = liveResolved.reduce((a, t) => a + t.pnl, 0);

  return {
    roi30d,
    tradeCount30d: trades.length,
    resolvedTradeCount30d: resolvedTrades.length,
    winRate30d: score.winRate,
    averageTradeSize: avg(buys.map((t) => t.sizeUsd)),
    averageLiquidity: avg(liqs),
    averageSpread: null,
    averageEntryTiming: null,
    liveTradeCount30d: liveBuys.length,
    liveResolvedCount30d: liveResolved.length,
    liveWinRate30d: liveResolved.length ? liveWins / liveResolved.length : null,
    liveRoi30d: liveCost > 0 ? livePnl / liveCost : null,
    swing: buildSwingStats(trades),
    score,
    status: statusForScore(score.globalScore, rules),
    resolvedTrades,
  };
}
