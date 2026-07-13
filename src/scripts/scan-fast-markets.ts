import { fetchActiveMarkets } from "@/lib/adapters";
import { log } from "@/lib/logger";
import { mineWalletsFromMarkets } from "@/lib/sourcing";
import { argValue, runScript } from "./_runner";

/**
 * Scalper hunter: mine FAST-RESOLVING markets (any category) — the ones closing
 * within a short window — and queue the wallets seen SELLING there. Fast markets
 * force round-trips, so their sellers are the odds-traders the PnL board hides.
 * Wallets are tagged "fast-market" and feed the /cazador desk + the 🔁 Trade
 * book once profiled as profitable swing traders.
 *
 * SAFETY: read-only discovery. No trades, no keys.
 */

runScript("scan:fast-markets", async (db) => {
  const scanLimit = Number(argValue("--markets") ?? 100); // markets to pull, then filter by endDate
  const maxHours = Number(argValue("--max-hours") ?? 48); // "fast" = resolves within this window
  const perMarket = Number(argValue("--per-market") ?? 100);
  const maxWallets = Number(argValue("--max-wallets") ?? 80);

  const now = Date.now();
  const cutoff = now + maxHours * 3600_000;
  // Filter by close date IN THE API (the busiest markets overall are long-dated,
  // so a client-side filter after ordering by volume would miss the fast ones).
  const all = await fetchActiveMarkets({
    limit: scanLimit,
    endDateMinIso: new Date(now).toISOString(),
    endDateMaxIso: new Date(cutoff).toISOString(),
  });
  const fast = all
    .filter((m) => m.endDateMs != null && m.endDateMs > now && m.endDateMs <= cutoff)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  log.info(`fast markets (<= ${maxHours}h): ${fast.length} of ${all.length} active`);
  if (fast.length === 0) {
    log.info("no fast-resolving markets right now — nothing to mine");
    return;
  }

  const { created, tagged } = await mineWalletsFromMarkets(db, fast, "fast-market", {
    perMarket,
    maxWallets,
    sellersOnly: true, // sellers in a fast market = round-trippers = scalper signal
  });
  log.info(`fast sourcing: ${created} new wallets queued, ${tagged} existing tagged fast-market`);
});
