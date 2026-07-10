import { fetchLeaderboard, fetchMarketsByConditionIds, fetchOneActiveMarket, fetchOrderBook } from "@/lib/adapters";
import { AdapterError } from "@/lib/adapters/types";

/**
 * One-shot adapter verification against the REAL public Polymarket APIs.
 * Prints exactly what worked and the ACTUAL error when something fails.
 * Read-only; makes 3 GET requests total.
 */
async function main() {
  let failures = 0;

  // 1) leaderboard
  try {
    const lb = await fetchLeaderboard({ window: "30d", rankType: "pnl", limit: 500 });
    console.log(`[OK] leaderboard: received ${lb.length} wallets (requested 500)`);
    if (lb[0]) {
      console.log(
        `     top wallet: ${lb[0].address} (${lb[0].label ?? "unlabeled"}) pnl=$${lb[0].pnl?.toFixed(0) ?? "?"}`,
      );
    }
  } catch (err) {
    failures++;
    console.error(`[FAIL] leaderboard: ${err instanceof AdapterError ? err.message : String(err)}`);
  }

  // 2) one market from gamma
  let tokenId: string | null = null;
  let conditionId: string | null = null;
  try {
    const market = await fetchOneActiveMarket();
    if (!market) throw new Error("gamma returned no active markets");
    tokenId = market.clobTokenIds[0] ?? null;
    conditionId = market.conditionId;
    console.log(`[OK] gamma market: "${market.question?.slice(0, 70)}" liquidity=$${market.liquidity?.toFixed(0) ?? "?"}`);
  } catch (err) {
    failures++;
    console.error(`[FAIL] gamma market: ${err instanceof AdapterError ? err.message : String(err)}`);
  }

  // 2b) market metadata by conditionId via CLOB (the pipeline's lookup path)
  if (conditionId) {
    try {
      const [info] = await fetchMarketsByConditionIds([conditionId]);
      if (!info) throw new Error(`CLOB returned no market for ${conditionId}`);
      console.log(
        `[OK] clob market lookup: "${info.question?.slice(0, 60)}" outcomes=${info.outcomes.join("/")} closed=${info.closed} resolved=${info.resolved}`,
      );
      tokenId = tokenId ?? info.clobTokenIds[0] ?? null;
    } catch (err) {
      failures++;
      console.error(`[FAIL] clob market lookup: ${err instanceof AdapterError ? err.message : String(err)}`);
    }
  }

  // 3) order book for that market
  if (tokenId) {
    try {
      const book = await fetchOrderBook(tokenId);
      console.log(
        `[OK] clob book: bestBid=${book.bestBid} bestAsk=${book.bestAsk} spread=${book.spread?.toFixed(3)} (${book.bids.length} bid / ${book.asks.length} ask levels)`,
      );
    } catch (err) {
      failures++;
      console.error(`[FAIL] clob book: ${err instanceof AdapterError ? err.message : String(err)}`);
    }
  } else {
    console.log("[SKIP] clob book: no tokenId available from gamma step");
  }

  if (failures > 0) {
    console.error(`\n${failures} adapter check(s) FAILED — real errors above, nothing faked.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll adapter checks passed against live public APIs.");
  }
}

main();
