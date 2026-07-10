import { httpGet } from "./http";
import {
  AdapterError,
  type LeaderboardEntry,
  type MarketInfo,
  type OrderBook,
  type WalletTrade,
} from "./types";

/**
 * Polymarket public API adapters (READ-ONLY).
 * - data-api  : leaderboard + wallet trade history
 * - gamma-api : market metadata / resolution status
 * - clob-api  : order books and prices (public market data endpoints only)
 *
 * No authentication, no keys, no order endpoints. Ever.
 */

const DATA_API = () => process.env.POLYMARKET_DATA_API ?? "https://data-api.polymarket.com";
const GAMMA_API = () => process.env.POLYMARKET_GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_API = () => process.env.POLYMARKET_CLOB_API ?? "https://clob.polymarket.com";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export async function fetchLeaderboard(opts?: {
  window?: "1d" | "7d" | "30d" | "all";
  rankType?: "pnl" | "vol";
  limit?: number;
}): Promise<LeaderboardEntry[]> {
  const window = opts?.window ?? "30d";
  const rankType = opts?.rankType ?? "pnl";
  const limit = opts?.limit ?? 500;
  const url = `${DATA_API()}/leaderboard?window=${window}&rankType=${rankType}&limit=${limit}`;
  const data = await httpGet("polymarket-data-api", url);
  if (!Array.isArray(data)) {
    throw new AdapterError("polymarket-data-api", url, 200, "unexpected leaderboard shape (not an array)");
  }
  return data.map((row: any, i: number) => ({
    address: String(row.proxyWallet ?? row.address ?? row.wallet ?? "").toLowerCase(),
    label: (row.name || row.pseudonym || null) as string | null,
    rank: num(row.rank) ?? i + 1,
    pnl: rankType === "pnl" ? num(row.amount) : num(row.pnl),
    volume: rankType === "vol" ? num(row.amount) : num(row.vol ?? row.volume),
    raw: row,
  }));
}

// ---------------------------------------------------------------------------
// Wallet trade history
// ---------------------------------------------------------------------------

export async function fetchWalletTrades(
  address: string,
  opts?: { limit?: number; sinceMs?: number },
): Promise<WalletTrade[]> {
  const maxTotal = opts?.limit ?? 500;
  const sinceMs = opts?.sinceMs ?? 0;
  const pageSize = 100;
  const trades: WalletTrade[] = [];
  for (let offset = 0; offset < maxTotal; offset += pageSize) {
    const url = `${DATA_API()}/trades?user=${address}&limit=${pageSize}&offset=${offset}`;
    const data = await httpGet("polymarket-data-api", url);
    if (!Array.isArray(data)) {
      throw new AdapterError("polymarket-data-api", url, 200, "unexpected trades shape (not an array)");
    }
    if (data.length === 0) break;
    let reachedOld = false;
    for (const row of data as any[]) {
      const tsMs = (num(row.timestamp) ?? 0) * 1000;
      if (sinceMs && tsMs < sinceMs) {
        reachedOld = true;
        continue;
      }
      const price = num(row.price) ?? 0;
      const shares = num(row.size) ?? 0;
      trades.push({
        walletAddress: String(row.proxyWallet ?? address).toLowerCase(),
        marketId: String(row.conditionId ?? row.market ?? row.slug ?? ""),
        conditionId: row.conditionId ? String(row.conditionId) : null,
        tokenId: row.asset ? String(row.asset) : null,
        marketQuestion: (row.title ?? row.question ?? null) as string | null,
        marketCategory: (row.category ?? null) as string | null,
        outcome: (row.outcome ?? null) as string | null,
        side: String(row.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
        price,
        sizeUsd: price * shares,
        timestampMs: tsMs,
        transactionHash: (row.transactionHash ?? null) as string | null,
        raw: row,
      });
    }
    if (reachedOld || data.length < pageSize) break;
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Markets (Gamma)
// ---------------------------------------------------------------------------

function toMarketInfo(row: any): MarketInfo {
  const outcomes = parseJsonArray(row.outcomes).map(String);
  const clobTokenIds = parseJsonArray(row.clobTokenIds).map(String);
  const outcomePrices = parseJsonArray(row.outcomePrices).map((p) => num(p) ?? 0);
  const closed = Boolean(row.closed);
  // A closed market whose prices collapsed to ~0/1 is resolved.
  let winningOutcomeIndex: number | null = null;
  if (closed && outcomePrices.length > 0) {
    const winner = outcomePrices.findIndex((p) => p >= 0.99);
    if (winner >= 0) winningOutcomeIndex = winner;
  }
  return {
    marketId: String(row.conditionId ?? row.id ?? ""),
    conditionId: row.conditionId ? String(row.conditionId) : null,
    question: (row.question ?? null) as string | null,
    category: (row.category ?? null) as string | null,
    outcomes,
    clobTokenIds,
    outcomePrices,
    liquidity: num(row.liquidityNum ?? row.liquidity),
    volume: num(row.volumeNum ?? row.volume),
    endDateMs: row.endDate ? Date.parse(String(row.endDate)) || null : null,
    closed,
    resolved: closed && winningOutcomeIndex !== null,
    winningOutcomeIndex,
    raw: row,
  };
}

export async function fetchMarketsByConditionIds(conditionIds: string[]): Promise<MarketInfo[]> {
  if (conditionIds.length === 0) return [];
  const out: MarketInfo[] = [];
  // Gamma supports repeated condition_ids params; batch to keep URLs short.
  const batchSize = 20;
  for (let i = 0; i < conditionIds.length; i += batchSize) {
    const batch = conditionIds.slice(i, i + batchSize);
    const qs = batch.map((c) => `condition_ids=${encodeURIComponent(c)}`).join("&");
    const url = `${GAMMA_API()}/markets?${qs}&limit=${batch.length}`;
    const data = await httpGet("polymarket-gamma-api", url);
    if (!Array.isArray(data)) {
      throw new AdapterError("polymarket-gamma-api", url, 200, "unexpected markets shape (not an array)");
    }
    for (const row of data) out.push(toMarketInfo(row));
  }
  return out;
}

export async function fetchOneActiveMarket(): Promise<MarketInfo | null> {
  const url = `${GAMMA_API()}/markets?active=true&closed=false&limit=1&order=volumeNum&ascending=false`;
  const data = await httpGet("polymarket-gamma-api", url);
  if (!Array.isArray(data) || data.length === 0) return null;
  return toMarketInfo(data[0]);
}

// ---------------------------------------------------------------------------
// Order books (CLOB, public market data)
// ---------------------------------------------------------------------------

export async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  const url = `${CLOB_API()}/book?token_id=${encodeURIComponent(tokenId)}`;
  const data: any = await httpGet("polymarket-clob-api", url);
  const rawBids = Array.isArray(data?.bids) ? data.bids : [];
  const rawAsks = Array.isArray(data?.asks) ? data.asks : [];
  const bids = rawBids
    .map((l: any) => ({ price: num(l.price) ?? 0, size: num(l.size) ?? 0 }))
    .filter((l: { price: number }) => l.price > 0)
    .sort((a: { price: number }, b: { price: number }) => b.price - a.price);
  const asks = rawAsks
    .map((l: any) => ({ price: num(l.price) ?? 0, size: num(l.size) ?? 0 }))
    .filter((l: { price: number }) => l.price > 0)
    .sort((a: { price: number }, b: { price: number }) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null;
  return { tokenId, bids, asks, bestBid, bestAsk, spread, raw: data };
}
