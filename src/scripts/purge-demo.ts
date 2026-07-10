import { eq, inArray, like } from "drizzle-orm";
import {
  dailyReports,
  decisionJournal,
  leaderboardScans,
  marketSnapshots,
  observedTrades,
  outcomeReviews,
  paperTrades,
  pnlSnapshots,
  walletProfiles,
} from "@/db/schema";
import { log } from "@/lib/logger";
import { runScript } from "./_runner";

/**
 * Remove every [DEMO] row so the dashboard shows REAL data only.
 * Idempotent: safe to run on every production boot (deletes nothing when
 * there is nothing to delete). Real rows are never touched — demo rows are
 * identified by the reserved 0xdemo… address/market prefix and seed markers.
 */
runScript("purge:demo", async (db) => {
  const demoPaperIds = db
    .select({ id: paperTrades.id })
    .from(paperTrades)
    .where(like(paperTrades.marketId, "0xdemo%"))
    .all()
    .map((r) => r.id);
  const demoDecisionIds = db
    .select({ id: decisionJournal.id })
    .from(decisionJournal)
    .where(like(decisionJournal.marketId, "0xdemo%"))
    .all()
    .map((r) => r.id);
  const demoWallets = db
    .select({ id: walletProfiles.id })
    .from(walletProfiles)
    .where(like(walletProfiles.address, "0xdemo%"))
    .all().length;

  if (demoPaperIds.length) db.delete(pnlSnapshots).where(inArray(pnlSnapshots.paperTradeId, demoPaperIds)).run();
  if (demoDecisionIds.length)
    db.delete(outcomeReviews).where(inArray(outcomeReviews.decisionJournalId, demoDecisionIds)).run();
  db.delete(paperTrades).where(like(paperTrades.marketId, "0xdemo%")).run();
  db.delete(decisionJournal).where(like(decisionJournal.marketId, "0xdemo%")).run();
  db.delete(observedTrades).where(like(observedTrades.marketId, "0xdemo%")).run();
  db.delete(marketSnapshots).where(like(marketSnapshots.marketId, "0xdemo%")).run();
  db.delete(walletProfiles).where(like(walletProfiles.address, "0xdemo%")).run();
  db.delete(dailyReports).where(like(dailyReports.summary, "[DEMO DATA]%")).run();
  db.delete(leaderboardScans).where(eq(leaderboardScans.source, "demo-seed")).run();

  if (demoWallets || demoPaperIds.length || demoDecisionIds.length) {
    log.info(
      `purged demo data: ${demoWallets} wallets, ${demoPaperIds.length} paper trades, ${demoDecisionIds.length} decisions (+ signals, snapshots, report)`,
    );
  } else {
    log.info("no demo data present — nothing to purge");
  }
});
