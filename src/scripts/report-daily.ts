import { desc, eq, gte } from "drizzle-orm";
import { dailyReports, decisionJournal, paperTrades, ruleChanges, walletProfiles } from "@/db/schema";
import { hypotheticalPnl } from "@/lib/benchmarks";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { getBenchmarkSummary, getOverviewStats, getWalletPaperPerformance } from "@/lib/queries";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * Step 14 of the loop: the end-of-day report. Stored in the DB (and shown in
 * the dashboard). Sent to Telegram ONLY if TELEGRAM_* env vars are set.
 */
runScript("report:daily", async (db) => {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const stats = getOverviewStats(db);
  const bench = getBenchmarkSummary(db);

  const todaysDecisions = db.select().from(decisionJournal).where(gte(decisionJournal.createdAt, dayStart)).all();
  const copied = todaysDecisions.filter((d) => d.decision === "paper_copy").length;
  const watched = todaysDecisions.filter((d) => d.decision === "watchlist").length;
  const skipped = todaysDecisions.filter((d) => d.decision === "skip").length;

  const resolvedToday = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.status, "resolved"))
    .all()
    .filter((t) => t.resolvedAt && t.resolvedAt >= dayStart);
  const pnlToday = resolvedToday.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);

  const walletPerf = getWalletPaperPerformance(db).sort((a, b) => b.totalPnl - a.totalPnl);
  const best = walletPerf.slice(0, 3);
  const worst = walletPerf.slice(-3).reverse().filter((w) => w.totalPnl < 0);

  const todaysChanges = db
    .select()
    .from(ruleChanges)
    .where(gte(ruleChanges.createdAt, dayStart))
    .orderBy(desc(ruleChanges.createdAt))
    .all();

  const bestTrade = resolvedToday.slice().sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0))[0];
  const worstTrade = resolvedToday.slice().sort((a, b) => (a.realizedPnl ?? 0) - (b.realizedPnl ?? 0))[0];

  const beatBlind =
    bench.botBeatsBlind === null ? "not enough resolved data yet" : bench.botBeatsBlind ? "YES" : "NO";

  const lines = [
    `La Sombra — EOD report ${today} (PAPER ONLY)`,
    `Paper PnL today: $${pnlToday.toFixed(2)} | total: $${stats.totalPaperPnl.toFixed(2)} (realized $${stats.realizedPnl.toFixed(2)} + open $${stats.unrealizedPnl.toFixed(2)})`,
    `Win rate (resolved): ${stats.winRate === null ? "n/a" : `${(stats.winRate * 100).toFixed(0)}%`} over ${stats.resolvedCount} trades`,
    `Signals today: ${todaysDecisions.length} (${copied} copied, ${watched} watchlist, ${skipped} skipped)`,
    `Open positions: ${stats.openPositions.length} | tracked wallets: ${stats.trackedWallets}`,
    bestTrade ? `Best trade today: ${(bestTrade.marketQuestion ?? bestTrade.marketId).slice(0, 60)} $${(bestTrade.realizedPnl ?? 0).toFixed(2)}` : "Best trade today: none resolved",
    worstTrade && worstTrade !== bestTrade ? `Worst trade today: ${(worstTrade.marketQuestion ?? worstTrade.marketId).slice(0, 60)} $${(worstTrade.realizedPnl ?? 0).toFixed(2)}` : "",
    `Bot-filtered beat blind copy: ${beatBlind} (bot avg $${bench.botFiltered.avgPnl ?? "n/a"} vs blind avg $${bench.blindCopy.avgPnl ?? "n/a"} per trade)`,
    `Missed winners: ${bench.missedWinners} | avoided losers: ${bench.avoidedLosers} | bad copies: ${bench.badCopies}`,
    todaysChanges.length
      ? `Rule changes today: ${todaysChanges.length} — ${todaysChanges.map((c) => c.reason).join(" | ").slice(0, 200)}`
      : "Rule changes today: none",
    `Watch tomorrow: ${stats.openPositions.length} open positions${best[0] ? `; top wallet ${best[0].walletAddress.slice(0, 10)}… ($${best[0].totalPnl})` : ""}`,
  ].filter(Boolean);

  const summary = lines.join("\n");

  let sent = false;
  if (telegramConfigured()) {
    sent = await sendTelegramMessage(summary);
    log.info(`telegram: ${sent ? "sent" : "FAILED (see error above)"}`);
  } else {
    log.info("telegram not configured — report stored in DB only");
  }

  const existing = db.select().from(dailyReports).where(eq(dailyReports.date, today)).get();
  const row = {
    date: today,
    paperPnl: Math.round(pnlToday * 100) / 100,
    winRate: stats.winRate,
    openPositions: stats.openPositions.length,
    newSignals: todaysDecisions.length,
    copiedSignals: copied,
    watchedSignals: watched,
    skippedSignals: skipped,
    bestWalletsJson: JSON.stringify(best),
    worstWalletsJson: JSON.stringify(worst),
    ruleChangesJson: JSON.stringify(
      todaysChanges.map((c) => ({ reason: c.reason, before: c.beforeJson, after: c.afterJson })),
    ),
    summary,
    sentToTelegram: sent,
    createdAt: new Date(),
  };
  if (existing) {
    db.update(dailyReports).set(row).where(eq(dailyReports.id, existing.id)).run();
    log.info(`daily report for ${today} updated`);
  } else {
    db.insert(dailyReports).values({ id: newId(), ...row }).run();
    log.info(`daily report for ${today} created`);
  }
  console.log("\n" + summary + "\n");
});
