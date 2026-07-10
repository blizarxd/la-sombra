/**
 * Adapter-layer types. Everything here is READ-ONLY market research data.
 * There is deliberately no type for orders, signatures, or keys.
 */

export interface LeaderboardEntry {
  address: string;
  label: string | null;
  rank: number;
  pnl: number | null; // USD profit over the window
  volume: number | null; // USD volume over the window
  raw: unknown;
}

export interface WalletTrade {
  walletAddress: string;
  marketId: string;
  conditionId: string | null;
  tokenId: string | null;
  marketQuestion: string | null;
  marketCategory: string | null;
  outcome: string | null;
  side: "BUY" | "SELL";
  price: number;
  sizeUsd: number;
  timestampMs: number;
  transactionHash: string | null;
  raw: unknown;
}

export interface MarketInfo {
  marketId: string;
  conditionId: string | null;
  question: string | null;
  category: string | null;
  outcomes: string[]; // e.g. ["Yes", "No"]
  clobTokenIds: string[]; // aligned with outcomes
  outcomePrices: number[]; // aligned with outcomes
  liquidity: number | null;
  volume: number | null;
  endDateMs: number | null;
  closed: boolean;
  resolved: boolean;
  /** For resolved markets: index into outcomes of the winner, if determinable. */
  winningOutcomeIndex: number | null;
  raw: unknown;
}

export interface BookLevel {
  price: number;
  size: number; // shares
}

export interface OrderBook {
  tokenId: string;
  bids: BookLevel[]; // sorted best (highest) first
  asks: BookLevel[]; // sorted best (lowest) first
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  raw: unknown;
}

/** Error thrown when an upstream API fails. NEVER swallowed into fake data. */
export class AdapterError extends Error {
  constructor(
    public readonly source: string,
    public readonly url: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(`[${source}] ${message} (url: ${url}, status: ${status ?? "network-error"})`);
    this.name = "AdapterError";
  }
}
