import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { dailyPicks, decisionJournal, observedTrades } from "@/db/schema";
import { fetchOrderBook } from "@/lib/adapters";
import { categorizeMarket } from "@/lib/category";
import { loadActiveCells } from "@/lib/cremaCells";
import { choosePicks, type PickCandidate } from "@/lib/dailyPick";
import { dayKeyTz, hourInAppTz } from "@/lib/format";
import { verdictFromCells } from "@/lib/goldEngine";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * 🎯 Freeze today's pick — ONE claim, published before the outcome is known.
 *
 * Idempotent by construction: the unique index on pick_date means a second run
 * finds today's row and stops. That is not an optimisation, it is the integrity
 * mechanism — a pick that can be re-chosen after the fact is worthless as
 * evidence, and re-picking is exactly how tipster records get laundered.
 *
 * A day with nothing worth publishing produces NO pick. "Hoy no hay pick" is a
 * real answer; manufacturing one every day fills the record with coin flips.
 *
 * PAPER ONLY: this writes a row recording a claim. It never places an order.
 */
runScript("pick:select", async (db) => {
  const now = new Date();
  const today = dayKeyTz(now);

  const existing = db.select().from(dailyPicks).where(eq(dailyPicks.pickDate, today)).get();
  if (existing) {
    log.info(`[pick:select] ${today} ya tiene pick (${existing.marketId}) — inmutable, no se re-elige`);
    return;
  }

  const active = loadActiveCells(db).cells;
  const sinceMs = Date.now() - 18 * 3600 * 1000;

  // Today's copy-worthy signals, freshest first. We only consider what the bot
  // itself decided to copy — the pick is a concentration of the existing
  // strategy, not a second, unvalidated one.
  const rows = db
    .select({
      marketId: decisionJournal.marketId,
      walletAddress: decisionJournal.walletAddress,
      copyScore: decisionJournal.copyScore,
      confidence: decisionJournal.confidence,
      tokenId: observedTrades.tokenId,
      marketQuestion: observedTrades.marketQuestion,
      outcome: observedTrades.outcome,
      detectedPrice: observedTrades.detectedPrice,
      createdAt: decisionJournal.createdAt,
    })
    .from(decisionJournal)
    .innerJoin(observedTrades, eq(decisionJournal.observedTradeId, observedTrades.id))
    .where(
      and(
        eq(decisionJournal.decision, "paper_copy"),
        gte(decisionJournal.createdAt, new Date(sinceMs)),
        eq(observedTrades.side, "BUY"),
      ),
    )
    .orderBy(desc(decisionJournal.copyScore))
    .limit(40)
    .all();

  if (rows.length === 0) {
    log.info(`[pick:select] ${today} — no hubo señales copiables hoy, no se publica pick`);
    return;
  }

  // One market only: the same game showing up from three wallets is one opinion.
  const seen = new Set<string>();
  const candidates: PickCandidate[] = [];
  for (const r of rows) {
    if (seen.has(r.marketId) || !r.tokenId) continue;
    seen.add(r.marketId);

    // Live book: the pick must be priced at what it would ACTUALLY cost right
    // now, not at whatever the wallet paid earlier.
    let bestAsk: number | null = null;
    let bestBid: number | null = null;
    try {
      const book = await fetchOrderBook(r.tokenId);
      bestAsk = book.bestAsk;
      bestBid = book.bestBid;
    } catch (err) {
      log.warn(`[pick:select] sin libro para ${r.marketId}: ${err instanceof Error ? err.message : String(err)}`);
      continue; // no price = no honest pick; never fall back to a stale one
    }
    if (bestAsk == null) continue;

    const category = categorizeMarket(r.marketQuestion);
    const verdict = verdictFromCells(active, {
      arm: "core",
      category,
      hourInAppTz: hourInAppTz(now),
      entryPrice: bestAsk,
    });
    // Exploratory hits are learning bets, not recommendations — never publish one.
    if (!verdict.gold || verdict.exploratory) continue;

    const cell = active.find((c) => c.id === verdict.ruleId) ?? null;
    candidates.push({
      marketId: r.marketId,
      tokenId: r.tokenId,
      marketQuestion: r.marketQuestion,
      outcome: r.outcome,
      walletAddress: r.walletAddress,
      category,
      entryPrice: bestAsk,
      bestBid,
      copyScore: r.copyScore,
      confidence: r.confidence,
      cellId: verdict.ruleId ?? null,
      cellLabel: cell?.label ?? verdict.ruleId ?? null,
      cellFloor: cell?.windows?.all?.strictLcb ?? null,
      cellRealN: cell?.realN ?? 0,
    });
    if (candidates.length >= 12) break; // enough to choose from; each costs an API call
  }

  const choices = choosePicks(candidates);
  if (choices.length === 0) {
    log.info(
      `[pick:select] ${today} — ${candidates.length} candidatos pero ninguno supera el estándar; HOY NO HAY PICK`,
    );
    return;
  }

  for (const [i, choice] of choices.entries()) {
    const c = choice.candidate;
    const spread = c.bestBid === null ? null : Math.round((c.entryPrice - c.bestBid) * 10000) / 10000;
    db.insert(dailyPicks)
      .values({
        id: newId(),
        pickDate: today,
        rank: i + 1, // 1 = pick of the day; 2-4 = alternates for building by hand
        publishedAt: now,
        marketId: c.marketId,
        tokenId: c.tokenId,
        marketQuestion: c.marketQuestion,
        outcome: c.outcome,
        entryPrice: c.entryPrice,
        bestBid: c.bestBid,
        spread,
        cellId: c.cellId,
        cellLabel: c.cellLabel,
        copyScore: c.copyScore,
        confidence: c.confidence,
        walletAddress: c.walletAddress,
        category: c.category,
        reasoning: choice.reasoning,
        status: "abierto",
        createdAt: now,
      })
      // Belt and braces: if two ticks race, the first write wins and stands.
      .onConflictDoNothing()
      .run();
  }

  const main = choices[0].candidate;
  log.info(
    `[pick:select] ${today} → ${choices.length} publicados · #1 ${main.marketQuestion ?? main.marketId} @ ${Math.round(main.entryPrice * 100)}¢`,
  );

  if (telegramConfigured()) {
    const lines = choices
      .map((ch, i) => {
        const c = ch.candidate;
        return (
          `${i === 0 ? "🥇" : `${i + 1}️⃣`} ${escapeHtml((c.marketQuestion ?? c.marketId).slice(0, 90))}\n` +
          `    <b>${escapeHtml(c.outcome ?? "?")}</b> a <b>${Math.round(c.entryPrice * 100)}¢</b>`
        );
      })
      .join("\n");
    await sendTelegramMessage(
      `🎯 <b>PICK DEL DÍA</b> · ${today}\n${lines}\n\n` +
        `${escapeHtml(choices[0].reasoning)}\n` +
        `<i>Solo el #1 cuenta para el historial. Los demás son alternativas.</i>\n` +
        `<i>Registro público en papel, congelado antes de saber el resultado. NO es consejo financiero.</i>`,
    );
  }
});
