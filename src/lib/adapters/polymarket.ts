import "../env";
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

/**
 * Endpoint verified live on 2026-07-10: GET data-api.polymarket.com/v1/leaderboard
 * (the old /leaderboard path 404s). The API caps pages at 50 rows but supports
 * offset pagination, so we page up to the requested limit.
 */
export async function fetchLeaderboard(opts?: {
  window?: "1d" | "7d" | "30d" | "all";
  rankType?: "pnl" | "vol";
  limit?: number;
}): Promise<LeaderboardEntry[]> {
  const window = opts?.window ?? "30d";
  const rankType = opts?.rankType ?? "pnl";
  const limit = opts?.limit ?? 500;
  const pageSize = 50; // observed server-side cap
  const out: LeaderboardEntry[] = [];
  for (let offset = 0; offset < limit; offset += pageSize) {
    const url = `${DATA_API()}/v1/leaderboard?window=${window}&rankType=${rankType}&limit=${Math.min(pageSize, limit - offset)}&offset=${offset}`;
    const data = await httpGet("polymarket-data-api", url);
    if (!Array.isArray(data)) {
      throw new AdapterError("polymarket-data-api", url, 200, "unexpected leaderboard shape (not an array)");
    }
    if (data.length === 0) break;
    for (const row of data as any[]) {
      out.push({
        address: String(row.proxyWallet ?? row.address ?? row.wallet ?? "").toLowerCase(),
        label: (row.userName || row.name || row.pseudonym || null) as string | null,
        rank: num(row.rank) ?? out.length + 1,
        pnl: num(row.pnl ?? row.amount),
        volume: num(row.vol ?? row.volume),
        raw: row,
      });
    }
    if (data.length < pageSize) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wallet trade history
// ---------------------------------------------------------------------------

/** Real Polymarket proxy wallets are 20-byte hex addresses. */
export function isRealAddress(address: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(address);
}

export async function fetchWalletTrades(
  address: string,
  opts?: { limit?: number; sinceMs?: number },
): Promise<WalletTrade[]> {
  if (!isRealAddress(address)) {
    // Verified live 2026-07-10: data-api silently IGNORES an invalid `user`
    // param and returns the global trade feed. Refuse instead of polluting
    // the research DB with other people's trades.
    throw new AdapterError(
      "polymarket-data-api",
      `${DATA_API()}/trades?user=${address}`,
      null,
      `refusing to fetch trades for non-hex address "${address}" (the API would return the global feed)`,
    );
  }
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
      // Defensive: keep only rows that actually belong to the queried wallet.
      if (row.proxyWallet && String(row.proxyWallet).toLowerCase() !== address.toLowerCase()) continue;
      const tsMs = (num(row.timestamp) ?? 0) * 1000;
      if (sinceMs && tsMs < sinceMs) {
        reachedOld = true;
        continue;
      }
      const price = num(row.price) ?? 0;
      const shares = num(row.size) ?? 0;
      trades.push({
        walletAddress: address.toLowerCase(),
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

/**
 * Recent trades on a specific market (data-api /trades?market=conditionId).
 * Verified live 2026-07-12: returns the market's trade feed with proxyWallet +
 * side, so we can discover WHO is actively trading a market (used to source
 * quota-scalper and crypto-active wallets that never show on the PnL board).
 */
export async function fetchMarketTrades(
  conditionId: string,
  opts?: { limit?: number },
): Promise<WalletTrade[]> {
  const limit = Math.min(opts?.limit ?? 100, 500);
  const url = `${DATA_API()}/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}`;
  const data = await httpGet("polymarket-data-api", url);
  if (!Array.isArray(data)) {
    throw new AdapterError("polymarket-data-api", url, 200, "unexpected trades shape (not an array)");
  }
  const trades: WalletTrade[] = [];
  for (const row of data as any[]) {
    const address = String(row.proxyWallet ?? "").toLowerCase();
    if (!isRealAddress(address)) continue;
    const price = num(row.price) ?? 0;
    const shares = num(row.size) ?? 0;
    trades.push({
      walletAddress: address,
      marketId: String(row.conditionId ?? row.market ?? row.slug ?? ""),
      conditionId: row.conditionId ? String(row.conditionId) : null,
      tokenId: row.asset ? String(row.asset) : null,
      marketQuestion: (row.title ?? row.question ?? null) as string | null,
      marketCategory: (row.category ?? null) as string | null,
      outcome: (row.outcome ?? null) as string | null,
      side: String(row.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
      price,
      sizeUsd: price * shares,
      timestampMs: (num(row.timestamp) ?? 0) * 1000,
      transactionHash: (row.transactionHash ?? null) as string | null,
      raw: row,
    });
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Markets (Gamma)
// ---------------------------------------------------------------------------

/**
 * Active markets carrying a Gamma tag (verified live 2026-07-12: tag_id=21 is
 * "Crypto"). Ordered by volume desc by default so we mine the busy markets.
 */
export async function fetchMarketsByTag(
  tagId: number,
  opts?: { limit?: number; order?: string },
): Promise<MarketInfo[]> {
  const limit = Math.min(opts?.limit ?? 20, 100);
  const order = opts?.order ?? "volumeNum";
  const url = `${GAMMA_API()}/markets?active=true&closed=false&tag_id=${tagId}&limit=${limit}&order=${order}&ascending=false`;
  const data = await httpGet("polymarket-gamma-api", url);
  if (!Array.isArray(data)) {
    throw new AdapterError("polymarket-gamma-api", url, 200, "unexpected markets shape (not an array)");
  }
  return (data as any[]).map(toMarketInfo);
}

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
    // Only trust an explicit game/event start — NOT startDate (that's market
    // creation, which would falsely flag pre-game trades as in-play).
    gameStartTimeMs: parseGameStart(row.gameStartTime ?? row.game_start_time),
    closed,
    resolved: closed && winningOutcomeIndex !== null,
    winningOutcomeIndex,
    raw: row,
  };
}

/** Parse a game/event start time (ISO or epoch) to ms, or null. */
function parseGameStart(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000; // sec vs ms
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * CLOB market metadata (verified live 2026-07-10): GET clob.polymarket.com/markets/{conditionId}.
 * Gamma's conditionIds filter silently ignores the parameter, so per-market
 * lookups go to the CLOB, whose response includes explicit token winner flags —
 * exactly what resolution detection needs. Liquidity/volume are not included
 * (callers estimate liquidity from the order book instead).
 */
function clobToMarketInfo(row: any): MarketInfo {
  const tokens: any[] = Array.isArray(row?.tokens) ? row.tokens : [];
  const outcomes = tokens.map((t) => String(t.outcome ?? ""));
  const clobTokenIds = tokens.map((t) => String(t.token_id ?? ""));
  const outcomePrices = tokens.map((t) => num(t.price) ?? 0);
  const closed = Boolean(row.closed);
  let winningOutcomeIndex: number | null = null;
  const winnerIdx = tokens.findIndex((t) => t.winner === true);
  if (winnerIdx >= 0) winningOutcomeIndex = winnerIdx;
  const tags: string[] = Array.isArray(row.tags) ? row.tags.map(String) : [];
  return {
    marketId: String(row.condition_id ?? ""),
    conditionId: row.condition_id ? String(row.condition_id) : null,
    question: (row.question ?? null) as string | null,
    category: tags[0] ?? null,
    outcomes,
    clobTokenIds,
    outcomePrices,
    liquidity: null, // not exposed by the CLOB metadata endpoint
    volume: null,
    endDateMs: row.end_date_iso ? Date.parse(String(row.end_date_iso)) || null : null,
    gameStartTimeMs: parseGameStart(row.game_start_time ?? row.gameStartTime),
    closed,
    resolved: winningOutcomeIndex !== null,
    winningOutcomeIndex,
    raw: row,
  };
}

export async function fetchMarketsByConditionIds(conditionIds: string[]): Promise<MarketInfo[]> {
  const out: MarketInfo[] = [];
  for (const cid of conditionIds) {
    const url = `${CLOB_API()}/markets/${encodeURIComponent(cid)}`;
    try {
      const data = await httpGet("polymarket-clob-api", url);
      out.push(clobToMarketInfo(data));
    } catch (err) {
      // A market the CLOB no longer serves (404) is real information: skip it.
      if (err instanceof AdapterError && err.status === 404) continue;
      throw err;
    }
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
