import { fetchMarketsByTag } from "@/lib/adapters";
import { log } from "@/lib/logger";
import { mineWalletsFromMarkets } from "@/lib/sourcing";
import { argValue, runScript } from "./_runner";

/**
 * Crypto wallet sourcing: mine the busiest CRYPTO markets (Gamma tag_id=21) and
 * queue the wallets active there for profiling (tagged "crypto-market"). Feeds
 * the /cripto observation desk and, for the profitable odds-traders among them,
 * the existing 🔁 Trade book.
 *
 * SAFETY: read-only discovery. No trades, no keys.
 */

const CRYPTO_TAG_ID = 21; // verified live 2026-07-12

runScript("scan:crypto-markets", async (db) => {
  const marketLimit = Number(argValue("--markets") ?? 20);
  const perMarket = Number(argValue("--per-market") ?? 100);
  const maxWallets = Number(argValue("--max-wallets") ?? 80);

  const markets = await fetchMarketsByTag(CRYPTO_TAG_ID, { limit: marketLimit });
  log.info(`crypto markets (tag ${CRYPTO_TAG_ID}): ${markets.length}`);
  if (markets.length === 0) {
    log.info("no active crypto markets returned — nothing to mine");
    return;
  }

  const { created, tagged } = await mineWalletsFromMarkets(db, markets, "crypto-market", {
    perMarket,
    maxWallets,
  });
  log.info(`crypto sourcing: ${created} new wallets queued, ${tagged} existing tagged crypto-market`);
});
