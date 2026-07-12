import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { dailyReports, decisionJournal, observedTrades, paperTrades, ruleChanges, walletProfiles } from "@/db/schema";
import { hypotheticalPnl } from "@/lib/benchmarks";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { APP_TZ } from "@/lib/format";
import { getBenchmarkSummary, getOverviewStats, getWalletPaperPerformance } from "@/lib/queries";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * Step 14 of the loop: the end-of-day report. Stored in the DB (and shown in
 * the dashboard). Sent to Telegram ONLY if TELEGRAM_* env vars are set.
 */
runScript("report:daily", async (db) => {
  // Report date in the project timezone (UTC-4) so the label matches Johan's day.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const stats = getOverviewStats(db);
  const bench = getBenchmarkSummary(db);

  const todaysDecisions = db.select().from(decisionJournal).where(gte(decisionJournal.createdAt, dayStart)).all();
  const copied = todaysDecisions.filter((d) => d.decision === "paper_copy").length;
  const watched = todaysDecisions.filter((d) => d.decision === "watchlist").length;
  const skipped = todaysDecisions.filter((d) => d.decision === "skip").length;

  // In-play (live) split of today's signals, via the observed-trade flag.
  const todaysObserved = todaysDecisions.length
    ? db
        .select({ id: observedTrades.id, inPlay: observedTrades.inPlay })
        .from(observedTrades)
        .where(inArray(observedTrades.id, todaysDecisions.map((d) => d.observedTradeId)))
        .all()
    : [];
  const inPlayIds = new Set(todaysObserved.filter((o) => o.inPlay).map((o) => o.id));
  const liveSignals = todaysDecisions.filter((d) => inPlayIds.has(d.observedTradeId));
  const liveCopied = liveSignals.filter((d) => d.decision === "paper_copy").length;

  const resolvedToday = db
    .select()
    .from(paperTrades)
    .where(and(ne(paperTrades.status, "open"), eq(paperTrades.track, "core")))
    .all()
    .filter((t) => (t.resolvedAt && t.resolvedAt >= dayStart) || (t.closedAt && t.closedAt >= dayStart));
  const pnlToday = resolvedToday.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);

  // ⚡ Live experiment ledger (separate books — reported on its own line).
  const liveTrades = db.select().from(paperTrades).where(eq(paperTrades.track, "live")).all();
  const liveResolved = liveTrades.filter((t) => t.status !== "open");
  const livePnl =
    liveResolved.reduce((a, t) => a + (t.realizedPnl ?? 0), 0) +
    liveTrades.filter((t) => t.status === "open").reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const liveWins = liveResolved.filter((t) => (t.realizedPnl ?? 0) > 0).length;

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
    bench.botBeatsBlind === null ? "aún sin datos resueltos suficientes" : bench.botBeatsBlind ? "SÍ" : "NO";

  const lines = [
    `La Sombra — reporte de cierre ${today} (SOLO PAPEL)`,
    `PnL en papel hoy: $${pnlToday.toFixed(2)} | total: $${stats.totalPaperPnl.toFixed(2)} (realizado $${stats.realizedPnl.toFixed(2)} + abierto $${stats.unrealizedPnl.toFixed(2)})`,
    `Tasa de acierto (resueltos): ${stats.winRate === null ? "n/d" : `${(stats.winRate * 100).toFixed(0)}%`} en ${stats.resolvedCount} trades`,
    `Señales hoy: ${todaysDecisions.length} (${copied} copiadas, ${watched} en vigilancia, ${skipped} descartadas)`,
    liveSignals.length ? `⚡ En vivo hoy: ${liveSignals.length} señales (${liveCopied} copiadas en papel)` : "",
    liveTrades.length
      ? `⚡ Experimento en vivo (libro aparte): ${liveTrades.length} copias, PnL $${livePnl.toFixed(2)}, acierto ${liveResolved.length ? `${((liveWins / liveResolved.length) * 100).toFixed(0)}% en ${liveResolved.length} resueltas` : "n/d"}`
      : "",
    `Posiciones abiertas: ${stats.openPositions.length} | billeteras seguidas: ${stats.trackedWallets}`,
    bestTrade ? `Mejor trade hoy: ${(bestTrade.marketQuestion ?? bestTrade.marketId).slice(0, 60)} $${(bestTrade.realizedPnl ?? 0).toFixed(2)}` : "Mejor trade hoy: ninguno resuelto",
    worstTrade && worstTrade !== bestTrade ? `Peor trade hoy: ${(worstTrade.marketQuestion ?? worstTrade.marketId).slice(0, 60)} $${(worstTrade.realizedPnl ?? 0).toFixed(2)}` : "",
    `Filtrado por el bot le gana a la copia ciega: ${beatBlind} (prom. bot $${bench.botFiltered.avgPnl ?? "n/d"} vs prom. ciega $${bench.blindCopy.avgPnl ?? "n/d"} por trade)`,
    `Ganadoras perdidas: ${bench.missedWinners} | perdedoras evitadas: ${bench.avoidedLosers} | malas copias: ${bench.badCopies}`,
    todaysChanges.length
      ? `Cambios de reglas hoy: ${todaysChanges.length} — ${todaysChanges.map((c) => c.reason).join(" | ").slice(0, 200)}`
      : "Cambios de reglas hoy: ninguno",
    `Vigilar mañana: ${stats.openPositions.length} posiciones abiertas${best[0] ? `; mejor billetera ${best[0].walletAddress.slice(0, 10)}… ($${best[0].totalPnl})` : ""}`,
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
