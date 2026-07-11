import { and, asc, eq } from "drizzle-orm";
import { decisionJournal, marketSnapshots, observedTrades, paperTrades, walletProfiles } from "@/db/schema";
import { fetchMarketsByConditionIds, fetchOrderBook, isInPlayTrade } from "@/lib/adapters";
import type { MarketInfo, OrderBook } from "@/lib/adapters/types";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { openPaperTrade } from "@/lib/paper/engine";
import { getActiveRules } from "@/lib/rules";
import { scoreTrade } from "@/lib/scoring/tradeScoring";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { argValue, runScript } from "./_runner";

/**
 * Steps 9-10 of the loop: score each newly observed trade against current
 * market conditions + active rules, journal the decision, and paper-copy
 * the strong ones with realistic fill simulation ($5-$20 by confidence).
 */

function categoryFit(strengthsJson: string | null, category: string | null, bestCategory: string | null): number {
  if (!category) return 50;
  if (bestCategory && bestCategory.toLowerCase() === category.toLowerCase()) return 80;
  if (!strengthsJson) return 50;
  try {
    const strengths = JSON.parse(strengthsJson) as Record<string, { trades: number; winRate: number }>;
    const s = strengths[category];
    if (!s || s.trades < 3) return 50;
    return Math.round(30 + s.winRate * 60); // winRate 0..1 -> 30..90
  } catch {
    return 50;
  }
}

runScript("score:trades", async (db) => {
  const batch = Number(argValue("--limit") ?? 30);
  const { rules, version } = getActiveRules(db);
  const { rules: liveRules } = getActiveRules(db, "live"); // ⚡ experiment's own rules

  const pending = db
    .select()
    .from(observedTrades)
    .where(eq(observedTrades.scored, false))
    .orderBy(asc(observedTrades.timestamp))
    .limit(batch)
    .all();
  if (pending.length === 0) {
    log.info("no unscored observed trades");
    return;
  }
  log.info(`scoring ${pending.length} observed trades with rule set v${version}`);

  const marketCache = new Map<string, MarketInfo>();
  const bookCache = new Map<string, OrderBook>();
  const counts = { paper_copy: 0, watchlist: 0, skip: 0, unfillable: 0 };

  for (const obs of pending) {
    const now = new Date();
    const wallet = db.select().from(walletProfiles).where(eq(walletProfiles.address, obs.walletAddress)).get();

    // --- market metadata (gamma) ---
    let market: MarketInfo | null = null;
    if (obs.conditionId) {
      if (!marketCache.has(obs.conditionId)) {
        const fetched = await fetchMarketsByConditionIds([obs.conditionId]);
        if (fetched[0]) marketCache.set(obs.conditionId, fetched[0]);
      }
      market = marketCache.get(obs.conditionId) ?? null;
    }

    // --- live order book (clob) ---
    let book: OrderBook | null = null;
    if (obs.tokenId) {
      if (!bookCache.has(obs.tokenId)) {
        try {
          bookCache.set(obs.tokenId, await fetchOrderBook(obs.tokenId));
        } catch (err) {
          // A dead book (e.g. market already closed) is real information, not an excuse to fake prices.
          log.warn(`book unavailable for token ${obs.tokenId}: ${err instanceof Error ? err.message : err}`);
        }
      }
      book = bookCache.get(obs.tokenId) ?? null;
    }

    const timeToResolutionHours =
      market?.endDateMs != null ? (market.endDateMs - Date.now()) / 3600_000 : null;
    const inPlay = market ? isInPlayTrade(obs.timestamp.getTime(), market) : null;

    // Liquidity: prefer market metadata; otherwise estimate from live book depth
    // (sum of resting notional on both sides).
    const bookLiquidity = book
      ? [...book.bids, ...book.asks].reduce((a, l) => a + l.price * l.size, 0)
      : null;
    const liquidity = market?.liquidity ?? bookLiquidity;

    // --- persist a market snapshot for later outcome reviews ---
    if (market || book) {
      db.insert(marketSnapshots)
        .values({
          id: newId(),
          marketId: obs.marketId,
          conditionId: obs.conditionId,
          question: market?.question ?? obs.marketQuestion,
          category: market?.category ?? obs.marketCategory,
          yesPrice: market?.outcomePrices?.[0] ?? null,
          noPrice: market?.outcomePrices?.[1] ?? null,
          bestBid: book?.bestBid ?? null,
          bestAsk: book?.bestAsk ?? null,
          spread: book?.spread ?? null,
          liquidity,
          volume: market?.volume ?? null,
          timeToResolution: timeToResolutionHours,
          collectedAt: now,
          rawMarketJson: JSON.stringify({ marketRaw: market?.raw ?? null, bookSummary: book ? { bestBid: book.bestBid, bestAsk: book.bestAsk, bidLevels: book.bids.length, askLevels: book.asks.length } : null }),
        })
        .run();
    }

    const result = scoreTrade(
      {
        walletGlobalScore: wallet?.globalScore ?? 0,
        walletRoiScore: wallet?.roi30d != null ? Math.min(100, Math.max(0, 40 + wallet.roi30d * 167)) : 0,
        walletConsistencyScore: wallet?.consistencyScore ?? 0,
        walletCopyabilityScore: wallet?.copyabilityScore ?? 0,
        walletCategoryScore: categoryFit(
          wallet?.categoryStrengthsJson ?? null,
          market?.category ?? obs.marketCategory,
          wallet?.bestCategory ?? null,
        ),
        side: obs.side,
        walletEntryPrice: obs.walletEntryPrice,
        currentAsk: book?.bestAsk ?? null,
        currentBid: book?.bestBid ?? null,
        spread: book?.spread ?? null,
        liquidity,
        timeToResolutionHours,
      },
      rules,
    );

    const risks = [...result.risks];
    const reasons = [...result.reasons];
    const journalId = newId();
    let filled = false;
    let decision = result.decision;

    // Exposure guard: never stack OPEN paper positions on the same
    // market/outcome — a wallet re-buying (or a second wallet on the same
    // market) must not multiply simulated exposure.
    if (decision === "paper_copy") {
      const dupConds = [
        eq(paperTrades.status, "open"),
        eq(paperTrades.track, "core"),
        eq(paperTrades.marketId, obs.marketId),
      ];
      if (obs.outcome) dupConds.push(eq(paperTrades.outcome, obs.outcome));
      const openAlready = db
        .select({ id: paperTrades.id })
        .from(paperTrades)
        .where(and(...dupConds))
        .get();
      if (openAlready) {
        decision = "skip";
        reasons.push("exposure guard: an open paper position already exists on this market/outcome");
      }
    }

    // --- paper copy with realistic fill simulation ---
    if (decision === "paper_copy" && result.simulatedPositionSize && book) {
      const open = openPaperTrade(db, {
        decisionJournalId: journalId,
        walletAddress: obs.walletAddress,
        marketId: obs.marketId,
        tokenId: obs.tokenId,
        marketQuestion: market?.question ?? obs.marketQuestion,
        outcome: obs.outcome,
        usdSize: result.simulatedPositionSize,
        book,
        now,
      });
      filled = open.opened;
      if (open.opened) {
        reasons.push(`paper fill: ${open.fill.reason}`);
        counts.paper_copy++;
        // Real-time alert (optional): a paper copy just opened.
        if (telegramConfigured()) {
          const q = escapeHtml((market?.question ?? obs.marketQuestion ?? obs.marketId).slice(0, 120));
          const fillPrice =
            open.fill.avgFillPrice !== null ? `${(open.fill.avgFillPrice * 100).toFixed(1)}¢` : "?";
          const liveTag = inPlay ? " ⚡ EN VIVO" : "";
          await sendTelegramMessage(
            `🟢 <b>La Sombra — copia en PAPEL abierta</b>${liveTag}\n${q}\n` +
              `Billetera ${obs.walletAddress.slice(0, 10)}… · puntaje ${Math.round(result.copyScore)}\n` +
              `Entrada $${(result.simulatedPositionSize ?? 0).toFixed(2)} a ${fillPrice}`,
          );
        }
      } else {
        risks.push(`UNFILLABLE: ${open.fill.reason} — no paper trade opened (fill-rate realism)`);
        counts.unfillable++;
      }
    } else if (decision === "paper_copy" && !book) {
      risks.push("UNFILLABLE: no order book available — no paper trade opened");
      counts.unfillable++;
    } else {
      counts[decision]++;
    }

    // --- ⚡ LIVE EXPERIMENT (parallel ledger, track="live") ---
    // Independently paper-copies IN-PLAY signals from quality wallets at a
    // small fixed size, deliberately WITHOUT the late-entry drift guard (live
    // prices move by nature — that is exactly what this ledger measures).
    // It never touches core stats: everything core filters track='core'.
    if (
      inPlay === true &&
      obs.side === "BUY" &&
      book &&
      (wallet?.globalScore ?? 0) >= liveRules.minWalletGlobalScore &&
      book.bestAsk !== null &&
      book.bestAsk >= liveRules.minEntryPrice &&
      book.bestAsk <= liveRules.maxEntryPrice &&
      (book.spread === null || book.spread <= liveRules.maxSpread) &&
      (liquidity === null || liquidity >= liveRules.minLiquidity)
    ) {
      const liveDup = [
        eq(paperTrades.status, "open"),
        eq(paperTrades.track, "live"),
        eq(paperTrades.marketId, obs.marketId),
      ];
      if (obs.outcome) liveDup.push(eq(paperTrades.outcome, obs.outcome));
      const liveOpen = db.select({ id: paperTrades.id }).from(paperTrades).where(and(...liveDup)).get();
      if (!liveOpen) {
        const liveTrade = openPaperTrade(db, {
          decisionJournalId: journalId,
          walletAddress: obs.walletAddress,
          marketId: obs.marketId,
          tokenId: obs.tokenId,
          marketQuestion: market?.question ?? obs.marketQuestion,
          outcome: obs.outcome,
          usdSize: liveRules.minPositionSize,
          book,
          track: "live",
          now,
        });
        if (liveTrade.opened) {
          reasons.push(`live experiment: opened $${liveRules.minPositionSize.toFixed(2)} in-play copy (parallel ledger)`);
          if (telegramConfigured()) {
            const q = escapeHtml((market?.question ?? obs.marketQuestion ?? obs.marketId).slice(0, 120));
            await sendTelegramMessage(
              `⚡ <b>EXPERIMENTO EN VIVO — copia en papel</b>\n${q}\n` +
                `Billetera ${obs.walletAddress.slice(0, 10)}… · entrada $${liveRules.minPositionSize.toFixed(2)} a ` +
                `${liveTrade.fill.avgFillPrice !== null ? (liveTrade.fill.avgFillPrice * 100).toFixed(1) : "?"}¢\n` +
                `(libro paralelo — no toca la estrategia principal)`,
            );
          }
        }
      }
    }

    db.insert(decisionJournal)
      .values({
        id: journalId,
        observedTradeId: obs.id,
        walletAddress: obs.walletAddress,
        marketId: obs.marketId,
        decision,
        copyScore: result.copyScore,
        confidence: result.confidence,
        reasonsJson: JSON.stringify(reasons),
        risksJson: JSON.stringify(risks),
        walletQualityScore: result.subscores.walletQualityScore,
        roiScore: result.subscores.roiScore,
        consistencyScore: result.subscores.consistencyScore,
        copyabilityScore: result.subscores.copyabilityScore,
        categoryFitScore: result.subscores.categoryFitScore,
        entryTimingScore: result.subscores.entryTimingScore,
        spreadScore: result.subscores.spreadScore,
        liquidityScore: result.subscores.liquidityScore,
        thesisScore: result.subscores.thesisScore,
        simulatedPositionSize: filled ? result.simulatedPositionSize : null,
        ruleSetVersion: version,
        createdAt: now,
      })
      .run();

    const detectedPrice = obs.side === "BUY" ? (book?.bestAsk ?? null) : (book?.bestBid ?? null);
    db.update(observedTrades)
      .set({ scored: true, detectedPrice, inPlay })
      .where(eq(observedTrades.id, obs.id))
      .run();

    // Keep wallet live-copyability metrics fresh (running average).
    if (wallet && detectedPrice !== null) {
      const drift = Math.abs(detectedPrice - obs.walletEntryPrice);
      const prevN = wallet.tradeCount30d ?? 0;
      const prevTiming = wallet.averageEntryTiming;
      const newTiming = prevTiming === null ? drift : prevTiming * 0.8 + drift * 0.2;
      const prevSpread = wallet.averageSpread;
      const newSpread =
        book?.spread == null ? prevSpread : prevSpread === null ? book.spread : prevSpread * 0.8 + book.spread * 0.2;
      db.update(walletProfiles)
        .set({ averageEntryTiming: newTiming, averageSpread: newSpread, updatedAt: now })
        .where(eq(walletProfiles.id, wallet.id))
        .run();
      void prevN;
    }
  }

  log.info(
    `decisions: ${counts.paper_copy} paper copies, ${counts.watchlist} watchlist, ${counts.skip} skips, ${counts.unfillable} unfillable`,
  );
});
