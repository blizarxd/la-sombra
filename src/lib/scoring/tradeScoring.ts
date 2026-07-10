import type { Rules } from "@/lib/rules";
import { clamp100 } from "./walletScoring";

/**
 * Trade (signal) scoring: given an observed trade by a tracked wallet plus
 * current market conditions, decide paper_copy / watchlist / skip.
 * Pure function — all I/O happens in the scripts.
 */

export interface TradeScoreInput {
  // wallet quality (from wallet_profiles)
  walletGlobalScore: number; // 0-100
  walletRoiScore: number; // 0-100
  walletConsistencyScore: number; // 0-100
  walletCopyabilityScore: number; // 0-100
  walletCategoryScore: number; // 0-100 fit of this market's category for this wallet
  // the observed trade
  side: "BUY" | "SELL";
  walletEntryPrice: number;
  // current market state
  currentAsk: number | null;
  currentBid: number | null;
  spread: number | null;
  liquidity: number | null;
  timeToResolutionHours: number | null;
  /** Optional thesis clarity score 0-100 (defaults to neutral 50). */
  thesisScore?: number;
}

export interface TradeScoreResult {
  decision: "paper_copy" | "watchlist" | "skip";
  copyScore: number; // 0-100
  confidence: number; // 0-1
  simulatedPositionSize: number | null; // USD 5-20 when paper_copy
  reasons: string[];
  risks: string[];
  hardSkip: boolean;
  subscores: {
    walletQualityScore: number;
    roiScore: number;
    consistencyScore: number;
    copyabilityScore: number;
    categoryFitScore: number;
    entryTimingScore: number;
    spreadScore: number;
    liquidityScore: number;
    thesisScore: number;
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function scoreTrade(input: TradeScoreInput, rules: Rules): TradeScoreResult {
  const reasons: string[] = [];
  const risks: string[] = [];
  let hardSkip = false;

  const entryPrice = input.side === "BUY" ? input.currentAsk : input.currentBid;
  const drift =
    entryPrice !== null ? Math.abs(entryPrice - input.walletEntryPrice) : null;

  // ---------------- hard gates (any failure -> skip) ----------------
  if (entryPrice === null) {
    hardSkip = true;
    risks.push("no book price available for our side");
  } else {
    if (input.side === "BUY" && entryPrice > rules.maxEntryPrice) {
      hardSkip = true;
      risks.push(`entry band: ask ${entryPrice.toFixed(2)} > max ${rules.maxEntryPrice} (extreme price)`);
    }
    if (input.side === "BUY" && entryPrice < rules.minEntryPrice) {
      hardSkip = true;
      risks.push(`entry band: ask ${entryPrice.toFixed(2)} < min ${rules.minEntryPrice} (lottery ticket)`);
    }
  }
  if (drift !== null && drift > rules.maxPriceDrift) {
    hardSkip = true;
    risks.push(`late entry: price moved ${drift.toFixed(3)} since wallet entry (> ${rules.maxPriceDrift})`);
  }
  if (input.spread !== null && input.spread > rules.maxSpread) {
    hardSkip = true;
    risks.push(`spread ${input.spread.toFixed(3)} > max ${rules.maxSpread}`);
  }
  if (input.liquidity !== null && input.liquidity < rules.minLiquidity) {
    hardSkip = true;
    risks.push(`liquidity $${Math.round(input.liquidity)} < min $${rules.minLiquidity}`);
  }
  if (input.timeToResolutionHours !== null) {
    if (input.timeToResolutionHours < rules.minTimeToResolutionHours) {
      hardSkip = true;
      risks.push(`resolves in ${input.timeToResolutionHours.toFixed(1)}h (< ${rules.minTimeToResolutionHours}h)`);
    }
    if (input.timeToResolutionHours > rules.maxTimeToResolutionHours) {
      hardSkip = true;
      risks.push(`resolution too far out (${Math.round(input.timeToResolutionHours / 24)}d)`);
    }
  }
  if (input.walletGlobalScore < rules.minWalletGlobalScore) {
    hardSkip = true;
    risks.push(`wallet score ${Math.round(input.walletGlobalScore)} < min ${rules.minWalletGlobalScore}`);
  }
  if (input.side === "SELL") {
    // v1 only copies directional BUY entries; a wallet's SELL is an exit signal.
    hardSkip = true;
    risks.push("SELL signals are treated as exit info, not copyable entries, in v1");
  }

  // ---------------- subscores 0-100 ----------------
  const entryTimingScore =
    drift === null ? 30 : clamp100(100 * clamp01(1 - drift / rules.maxPriceDrift));
  const spreadScore =
    input.spread === null ? 30 : clamp100(100 * clamp01(1 - input.spread / rules.maxSpread));
  const liquidityScore =
    input.liquidity === null
      ? 30
      : clamp100(50 + 50 * clamp01(Math.log10(Math.max(input.liquidity, 1) / rules.minLiquidity)));
  const thesisScore = clamp100(input.thesisScore ?? 50);

  const w = rules.tradeWeights;
  const copyScore = clamp100(
    input.walletGlobalScore * w.walletQuality +
      input.walletRoiScore * w.roi +
      input.walletConsistencyScore * w.consistency +
      input.walletCopyabilityScore * w.copyability +
      input.walletCategoryScore * w.categoryFit +
      entryTimingScore * w.entryTiming +
      spreadScore * w.spread +
      liquidityScore * w.liquidity +
      thesisScore * w.thesis,
  );

  // ---------------- decision ----------------
  let decision: TradeScoreResult["decision"];
  if (hardSkip) {
    decision = "skip";
  } else if (copyScore >= rules.paperCopyThreshold) {
    decision = "paper_copy";
    reasons.push(`copy score ${Math.round(copyScore)} >= ${rules.paperCopyThreshold}`);
  } else if (copyScore >= rules.watchlistThreshold) {
    decision = "watchlist";
    reasons.push(`copy score ${Math.round(copyScore)} in watchlist band`);
  } else {
    decision = "skip";
    reasons.push(`copy score ${Math.round(copyScore)} < ${rules.watchlistThreshold}`);
  }

  if (!hardSkip) {
    if (entryTimingScore >= 70) reasons.push("entry close to wallet's price");
    if (spreadScore >= 70) reasons.push("tight spread");
    if (liquidityScore >= 70) reasons.push("healthy liquidity");
    if (input.walletGlobalScore >= 70) reasons.push("high-quality wallet");
    if (input.walletCategoryScore >= 70) reasons.push("wallet is strong in this category");
    if (spreadScore < 50) risks.push("spread eats into edge");
    if (liquidityScore < 50) risks.push("liquidity is thin-ish");
  }

  // ---------------- sizing: confidence -> $5-$20 ----------------
  const confidence = clamp01(copyScore / 100);
  let simulatedPositionSize: number | null = null;
  if (decision === "paper_copy") {
    const span = rules.maxPositionSize - rules.minPositionSize;
    const t = clamp01(
      (copyScore - rules.paperCopyThreshold) / Math.max(1, 100 - rules.paperCopyThreshold),
    );
    simulatedPositionSize = Math.round((rules.minPositionSize + span * t) * 100) / 100;
  }

  return {
    decision,
    copyScore,
    confidence,
    simulatedPositionSize,
    reasons,
    risks,
    hardSkip,
    subscores: {
      walletQualityScore: input.walletGlobalScore,
      roiScore: input.walletRoiScore,
      consistencyScore: input.walletConsistencyScore,
      copyabilityScore: input.walletCopyabilityScore,
      categoryFitScore: input.walletCategoryScore,
      entryTimingScore,
      spreadScore,
      liquidityScore,
      thesisScore,
    },
  };
}
