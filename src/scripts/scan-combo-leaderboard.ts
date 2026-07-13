import { eq } from "drizzle-orm";
import { walletProfiles } from "@/db/schema";
import { fetchComboLeaderboard, fetchProfileProxyWallet, isRealAddress } from "@/lib/adapters";
import { dayKeyTz } from "@/lib/format";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { mergeSource } from "@/lib/sourcing";
import { runScript } from "./_runner";

/**
 * 🧩 Combo wallet sourcing: scrape the Combo Cup leaderboard (today +
 * yesterday), resolve each winner to its proxy wallet, and queue it for combo
 * profiling tagged "combo-cup". A board appearance alone does NOT make a
 * wallet copyable — one lucky parlay is survivorship bias in its purest form.
 * Eligibility comes from profile-combo-wallets (positive combo cashflow).
 *
 * SAFETY: read-only discovery (HTML scrape + profile pages). No trades, no keys.
 */

runScript("scan:combo-leaderboard", async (db) => {
  const now = new Date();
  const today = dayKeyTz(now);

  type Found = { address: string; username: string; rank: number; payoutUsd: number | null };
  const found = new Map<string, Found>();
  let unresolved = 0;

  for (const period of ["today", "yesterday"] as const) {
    let rows;
    try {
      rows = await fetchComboLeaderboard(period);
    } catch (err) {
      // A broken scrape is real information — log it loudly and keep the other period.
      log.error(`combo leaderboard (${period}) failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    log.info(`combo leaderboard (${period}): ${rows.length} rows`);
    for (const row of rows) {
      let address = row.address;
      if (!address && row.profilePath) {
        try {
          address = await fetchProfileProxyWallet(row.profilePath);
        } catch (err) {
          log.warn(`profile resolve failed for ${row.profilePath}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!address || !isRealAddress(address)) {
        unresolved++;
        continue;
      }
      const prev = found.get(address);
      if (!prev || row.rank < prev.rank) {
        found.set(address, { address, username: row.username, rank: row.rank, payoutUsd: row.payoutUsd });
      }
    }
  }
  log.info(`combo board wallets resolved: ${found.size} (${unresolved} unresolved handles)`);

  let created = 0;
  let updated = 0;
  for (const f of found.values()) {
    const existing = db.select().from(walletProfiles).where(eq(walletProfiles.address, f.address)).get();
    // Count at most ONE board appearance per calendar day (the scan may run
    // more than once a day via bootstrap).
    const seenToday = existing?.comboLastBoardAt ? dayKeyTz(existing.comboLastBoardAt) === today : false;
    if (existing) {
      db.update(walletProfiles)
        .set({
          sources: mergeSource(existing.sources, "combo-cup"),
          label: existing.label ?? f.username,
          comboBoardAppearances: (existing.comboBoardAppearances ?? 0) + (seenToday ? 0 : 1),
          comboLastBoardAt: now,
          updatedAt: now,
        })
        .where(eq(walletProfiles.id, existing.id))
        .run();
      updated++;
      continue;
    }
    db.insert(walletProfiles)
      .values({
        id: newId(),
        address: f.address,
        label: f.username,
        sourceRank: 8000 + f.rank, // synthetic: after real leaderboard ranks
        status: "watch",
        sources: "combo-cup",
        comboBoardAppearances: 1,
        comboLastBoardAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    created++;
  }
  log.info(`combo sourcing: ${created} new wallets queued, ${updated} existing tagged/refreshed`);
});
