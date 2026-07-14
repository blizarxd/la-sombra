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

// Hard budget so this scrape can NEVER stall the operator tick / watchdog.
const TIME_BUDGET_MS = 4 * 60 * 1000; // whole scan aborts cleanly past this
const MAX_PROFILE_FETCHES = 30; // most rows embed the address; only some need a profile page

runScript("scan:combo-leaderboard", async (db) => {
  const now = new Date();
  const today = dayKeyTz(now);
  const deadline = now.getTime() + TIME_BUDGET_MS;

  type Found = { address: string; username: string; rank: number; payoutUsd: number | null };
  const found = new Map<string, Found>();
  let unresolved = 0;
  let profileFetches = 0;

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
      if (Date.now() > deadline) {
        log.warn("combo scan hit its time budget — stopping early (rest picked up next daily cycle)");
        break;
      }
      let address = row.address;
      // Resolve username-only rows via the profile page, but bound how many —
      // an unbounded run of profile fetches is what ballooned to minutes.
      if (!address && row.profilePath && profileFetches < MAX_PROFILE_FETCHES) {
        profileFetches++;
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
  log.info(`combo board wallets resolved: ${found.size} (${unresolved} unresolved, ${profileFetches} profile fetches)`);

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
