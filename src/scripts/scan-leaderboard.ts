import { eq } from "drizzle-orm";
import { leaderboardScans, walletProfiles } from "@/db/schema";
import { fetchLeaderboard } from "@/lib/adapters";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { argValue, runScript } from "./_runner";

/**
 * Step 1-2 of the loop: pull the Polymarket 30d PnL leaderboard (top 500 by
 * default) and upsert wallet profile skeletons for later deep profiling.
 */
runScript("scan:leaderboard", async (db) => {
  const limit = Number(argValue("--limit") ?? process.env.LEADERBOARD_SCAN_LIMIT ?? 500);
  const entries = await fetchLeaderboard({ window: "30d", rankType: "pnl", limit });
  log.info(`leaderboard returned ${entries.length} wallets (requested ${limit})`);

  const now = new Date();
  db.insert(leaderboardScans)
    .values({
      id: newId(),
      source: "polymarket-data-api",
      scannedAt: now,
      walletCount: entries.length,
      lookbackDays: 30,
      rawSummaryJson: JSON.stringify({
        requestedLimit: limit,
        received: entries.length,
        top10: entries.slice(0, 10).map((e) => ({ address: e.address, label: e.label, pnl: e.pnl })),
      }),
    })
    .run();

  let created = 0;
  let updated = 0;
  for (const e of entries) {
    if (!e.address) continue;
    const existing = db.select().from(walletProfiles).where(eq(walletProfiles.address, e.address)).get();
    if (existing) {
      db.update(walletProfiles)
        .set({ sourceRank: e.rank, label: e.label ?? existing.label, updatedAt: now })
        .where(eq(walletProfiles.id, existing.id))
        .run();
      updated++;
    } else {
      db.insert(walletProfiles)
        .values({
          id: newId(),
          address: e.address,
          label: e.label,
          sourceRank: e.rank,
          status: "watch",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created++;
    }
  }
  log.info(`wallet profiles: ${created} created, ${updated} updated`);
});
