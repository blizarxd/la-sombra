import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { decisionJournal, eliteRoster, marketSnapshots, observedTrades, paperTrades, walletProfiles } from "@/db/schema";
import { fetchMarketsByConditionIds, fetchOrderBook, isInPlayTrade } from "@/lib/adapters";
import type { MarketInfo, OrderBook } from "@/lib/adapters/types";
import { categorizeMarket } from "@/lib/category";
import { effectiveMinEntryPrice, isCategoryExcluded } from "@/lib/categoryEntryBand";
import { ELITE_POSITION_SIZE } from "@/lib/elite";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { getControlSettings } from "@/lib/control";
import { closePaperTrade, openPaperTrade } from "@/lib/paper/engine";
import { isCryptoBookEligible, isQuotaTraderEligible } from "@/lib/profiler";
import { getActiveRules } from "@/lib/rules";
import { scoreTrade } from "@/lib/scoring/tradeScoring";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { argValue, runScript } from "./_runner";

/**
 * 🏆 Elite ("la crema") mirror: if the wallet that JUST got copied by `arm`
 * is currently that arm's weekly top-10 (elite_roster), ALSO open the same
 * fill into the elite ledger. No entry rules of its own — the arm's own
 * gates already decided this was worth copying; elite adds exactly one more
 * filter (confirmed weekly winner) on top. Reuses the already-fetched book,
 * so this costs no extra API call.
 */
async function maybeOpenEliteMirror(
  db: Db,
  params: {
    arm: "core" | "live" | "trade" | "crypto";
    journalId: string;
    walletAddress: string;
    marketId: string;
    tokenId: string | null;
    marketQuestion: string | null;
    outcome: string | null;
    book: OrderBook;
    now: Date;
  },
): Promise<void> {
  const onRoster = db
    .select({ id: eliteRoster.id })
    .from(eliteRoster)
    .where(and(eq(eliteRoster.arm, params.arm), eq(eliteRoster.walletAddress, params.walletAddress)))
    .get();
  if (!onRoster) return;

  const dupConds = [
    eq(paperTrades.status, "open"),
    eq(paperTrades.track, "elite"),
    eq(paperTrades.marketId, params.marketId),
  ];
  if (params.outcome) dupConds.push(eq(paperTrades.outcome, params.outcome));
  const already = db.select({ id: paperTrades.id }).from(paperTrades).where(and(...dupConds)).get();
  if (already) return;

  const opened = openPaperTrade(db, {
    decisionJournalId: params.journalId,
    walletAddress: params.walletAddress,
    marketId: params.marketId,
    tokenId: params.tokenId,
    marketQuestion: params.marketQuestion,
    outcome: params.outcome,
    usdSize: ELITE_POSITION_SIZE,
    book: params.book,
    track: "elite",
    now: params.now,
  });
  if (opened.opened) {
    log.info(`elite mirror: opened $${ELITE_POSITION_SIZE.toFixed(2)} copy of ${params.arm}'s top-10 wallet ${params.walletAddress.slice(0, 10)}…`);
    if (telegramConfigured()) {
      const q = escapeHtml((params.marketQuestion ?? params.marketId).slice(0, 120));
      await sendTelegramMessage(
        `🏆 <b>LA CREMA — copia en papel</b>\n${q}\n` +
          `Billetera ${params.walletAddress.slice(0, 10)}… (top-10 semanal de ${params.arm}) · entrada $${ELITE_POSITION_SIZE.toFixed(2)}\n` +
          `(nos copiamos a nosotros mismos — solo lo mejor de lo mejor, libro aparte)`,
      );
    }
  }
}

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
  const { rules: tradeRules } = getActiveRules(db, "trade"); // 🔁 quota-scalper book's own rules
  const { rules: cryptoRules } = getActiveRules(db, "crypto"); // ₿ crypto book's own rules
  const control = getControlSettings(db); // manual ⚡ live on/off + stake (paper only)

  // --- Expire signals too old to have acted on (added 2026-07-16) ---
  // This scorer walks the unscored queue OLDEST-FIRST, `batch` at a time, and
  // every signal costs 2 upstream calls (market + book). That is fine while the
  // queue is short. It is fatal once the queue is long: the scorer spends its
  // whole budget on dead signals from days ago and NEVER reaches the ones from
  // minutes ago. On 2026-07-16 that killed the live book outright — inPlay is
  // only set here, at scoring time, so in-play bets that were never reached
  // stayed unclassified and the live book logged ZERO signals for a full day
  // while games were running. It also poisoned the journal with decisions on
  // markets that had ALREADY RESOLVED ("resolves in -38.8h").
  //
  // Judging a signal we could never have acted on is not data, it is a
  // counterfactual: it invents a decision at a price we never saw and pollutes
  // the bot-vs-blind-copy benchmark with it. So drop them, cheaply and in bulk
  // (no API calls), and keep the budget for signals still live enough to copy.
  // They stay in the DB as scored-with-no-journal-entry, which is exactly the
  // queryable signature of "seen but never judged".
  const STALE_SIGNAL_HOURS = 6;
  const staleBefore = new Date(Date.now() - STALE_SIGNAL_HOURS * 3600_000);
  const expired = db
    .update(observedTrades)
    .set({ scored: true })
    .where(and(eq(observedTrades.scored, false), lt(observedTrades.timestamp, staleBefore)))
    .run();
  if (expired.changes > 0) {
    log.warn(
      `expired ${expired.changes} unscored signals older than ${STALE_SIGNAL_HOURS}h — too late to copy, not judged. ` +
        `A large number here means the scorer is falling behind live inflow.`,
    );
  }

  // NEWEST FIRST — deliberately (flipped from oldest-first on 2026-07-16).
  //
  // This is a COPY bot: the freshest signal is the only one we could actually
  // act on, and the live book needs in-play bets scored within MINUTES or the
  // game ends and the order book dies. Oldest-first guaranteed the exact
  // opposite — maximum latency on every signal — and the result was measured:
  // 199 in-play signals detected on 2026-07-16 and ZERO live copies opened,
  // because by the time each one was scored its book was gone (`book` null ->
  // the live gate can't fire). Core had the same disease more quietly: it
  // "decided" at prices that no longer existed.
  //
  // Working newest-first, the tail drains backwards on its own and whatever
  // never gets reached is capped at STALE_SIGNAL_HOURS and dropped above —
  // which is correct, because a signal that old was never copyable anyway.
  const pending = db
    .select()
    .from(observedTrades)
    .where(eq(observedTrades.scored, false))
    .orderBy(desc(observedTrades.timestamp))
    .limit(batch)
    .all();
  if (pending.length === 0) {
    log.info("no unscored observed trades");
    return;
  }
  log.info(`scoring ${pending.length} observed trades with rule set v${version}`);

  const marketCache = new Map<string, MarketInfo>();
  const bookCache = new Map<string, OrderBook>();
  const counts = { paper_copy: 0, watchlist: 0, skip: 0, unfillable: 0, exits: 0 };

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

    // Category-aware entry floor: a book-wide minEntryPrice never blindly
    // clobbers a category with a different sweet spot (evidence in /matriz).
    // Only tightens rules.minEntryPrice, never loosens it — see categoryEntryBand.ts.
    const marketCategory = categorizeMarket(market?.question ?? obs.marketQuestion);
    const coreRulesForThisTrade = {
      ...rules,
      minEntryPrice: effectiveMinEntryPrice("core", marketCategory, rules.minEntryPrice),
    };

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
      coreRulesForThisTrade,
    );

    const risks = [...result.risks];
    const reasons = [...result.reasons];
    const journalId = newId();
    let filled = false;
    let decision = result.decision;
    let blockedGate = result.blockedGate; // for the skip autopsy

    // --- copy the exit: the wallet we copied just SOLD this market/outcome ---
    // Close our open paper copies of THAT wallet at the current bids (both
    // ledgers). This mirrors the wallet's real behavior instead of blindly
    // holding to resolution.
    if (obs.side === "SELL" && book) {
      const exitConds = [
        eq(paperTrades.status, "open"),
        eq(paperTrades.marketId, obs.marketId),
        eq(paperTrades.walletAddress, obs.walletAddress),
      ];
      if (obs.outcome) exitConds.push(eq(paperTrades.outcome, obs.outcome));
      const openCopies = db.select().from(paperTrades).where(and(...exitConds)).all();
      for (const pos of openCopies) {
        const closed = closePaperTrade(db, pos, book, now);
        if (!closed) {
          risks.push("wallet sold but the bid side is empty — paper position left open");
          continue;
        }
        counts.exits++;
        reasons.push(
          `exit copied: closed ${pos.track} paper position at ${(closed.exitPrice * 100).toFixed(1)}¢ (pnl $${closed.realizedPnl.toFixed(2)})`,
        );
        if (telegramConfigured()) {
          const q = escapeHtml((market?.question ?? obs.marketQuestion ?? obs.marketId).slice(0, 120));
          const emoji = closed.realizedPnl >= 0 ? "🟩" : "🟥";
          await sendTelegramMessage(
            `📤 <b>La Sombra — salida copiada (PAPEL${pos.track === "live" ? " ⚡" : ""})</b>\n${q}\n` +
              `La billetera ${obs.walletAddress.slice(0, 10)}… vendió — cerramos a ${(closed.exitPrice * 100).toFixed(1)}¢\n` +
              `${emoji} PnL realizado $${closed.realizedPnl.toFixed(2)}`,
          );
        }
      }
    }

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
        blockedGate = "exposure_dup";
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
        await maybeOpenEliteMirror(db, {
          arm: "core",
          journalId,
          walletAddress: obs.walletAddress,
          marketId: obs.marketId,
          tokenId: obs.tokenId,
          marketQuestion: market?.question ?? obs.marketQuestion,
          outcome: obs.outcome,
          book,
          now,
        });
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
    // Category exclusion: skip whole categories the matrix shows live can't
    // predict in-play regardless of price (clima/weather: 13% win, ROI -55%).
    if (
      control.liveEnabled &&
      inPlay === true &&
      obs.side === "BUY" &&
      book &&
      !isCategoryExcluded("live", marketCategory) &&
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
          usdSize: control.liveStakeUsd,
          book,
          track: "live",
          now,
        });
        if (liveTrade.opened) {
          reasons.push(`live experiment: opened $${control.liveStakeUsd.toFixed(2)} in-play copy (parallel ledger)`);
          if (telegramConfigured()) {
            const q = escapeHtml((market?.question ?? obs.marketQuestion ?? obs.marketId).slice(0, 120));
            await sendTelegramMessage(
              `⚡ <b>EXPERIMENTO EN VIVO — copia en papel</b>\n${q}\n` +
                `Billetera ${obs.walletAddress.slice(0, 10)}… · entrada $${control.liveStakeUsd.toFixed(2)} a ` +
                `${liveTrade.fill.avgFillPrice !== null ? (liveTrade.fill.avgFillPrice * 100).toFixed(1) : "?"}¢\n` +
                `(libro paralelo — no toca la estrategia principal)`,
            );
          }
          await maybeOpenEliteMirror(db, {
            arm: "live",
            journalId,
            walletAddress: obs.walletAddress,
            marketId: obs.marketId,
            tokenId: obs.tokenId,
            marketQuestion: market?.question ?? obs.marketQuestion,
            outcome: obs.outcome,
            book,
            now,
          });
        }
      }
    }

    // --- 🔁 TRADE BOOK (parallel ledger, track="trade") ---
    // The quota-scalper experiment: copies buy->sell ROUND-TRIPS of wallets
    // whose profile shows they trade the odds (sell early) PROFITABLY. Opens
    // here on their BUY (pre-game or in-play) with coherent gates like the
    // other books; the exit is closed by the SELL block above when they sell.
    // Its own book/rules — never touches core or live stats.
    const isQuotaTrader = wallet
      ? isQuotaTraderEligible({
          tradingStyle: wallet.tradingStyle,
          swingPnl30d: wallet.swingPnl30d,
          swingWinRate30d: wallet.swingWinRate30d,
          sellCount30d: wallet.sellCount30d,
        })
      : false;
    const tradeDrift =
      book?.bestAsk != null ? Math.abs(book.bestAsk - obs.walletEntryPrice) : null;
    // No holder-score gate here: the trade book is judged on the wallet's SWING
    // record (encoded in isQuotaTrader), not its hold-to-resolution score.
    if (
      isQuotaTrader &&
      obs.side === "BUY" &&
      book &&
      book.bestAsk !== null &&
      book.bestAsk >= tradeRules.minEntryPrice &&
      book.bestAsk <= tradeRules.maxEntryPrice &&
      (tradeDrift === null || tradeDrift <= tradeRules.maxPriceDrift) &&
      (book.spread === null || book.spread <= tradeRules.maxSpread) &&
      (liquidity === null || liquidity >= tradeRules.minLiquidity)
    ) {
      const tradeDup = [
        eq(paperTrades.status, "open"),
        eq(paperTrades.track, "trade"),
        eq(paperTrades.marketId, obs.marketId),
      ];
      if (obs.outcome) tradeDup.push(eq(paperTrades.outcome, obs.outcome));
      const tradeOpen = db.select({ id: paperTrades.id }).from(paperTrades).where(and(...tradeDup)).get();
      if (!tradeOpen) {
        const tradeTrade = openPaperTrade(db, {
          decisionJournalId: journalId,
          walletAddress: obs.walletAddress,
          marketId: obs.marketId,
          tokenId: obs.tokenId,
          marketQuestion: market?.question ?? obs.marketQuestion,
          outcome: obs.outcome,
          usdSize: tradeRules.minPositionSize,
          book,
          track: "trade",
          now,
        });
        if (tradeTrade.opened) {
          reasons.push(`trade book: opened $${tradeRules.minPositionSize.toFixed(2)} scalp copy of a quota-trader (parallel ledger)`);
          if (telegramConfigured()) {
            const q = escapeHtml((market?.question ?? obs.marketQuestion ?? obs.marketId).slice(0, 120));
            await sendTelegramMessage(
              `🔁 <b>LIBRO TRADE — copia de cuota (papel)</b>\n${q}\n` +
                `Billetera ${obs.walletAddress.slice(0, 10)}… (tradea cuota) · entrada $${tradeRules.minPositionSize.toFixed(2)} a ` +
                `${tradeTrade.fill.avgFillPrice !== null ? (tradeTrade.fill.avgFillPrice * 100).toFixed(1) : "?"}¢\n` +
                `(cerramos cuando la billetera venda — libro aparte)`,
            );
          }
          await maybeOpenEliteMirror(db, {
            arm: "trade",
            journalId,
            walletAddress: obs.walletAddress,
            marketId: obs.marketId,
            tokenId: obs.tokenId,
            marketQuestion: market?.question ?? obs.marketQuestion,
            outcome: obs.outcome,
            book,
            now,
          });
        }
      }
    }

    // --- ₿ CRYPTO BOOK (parallel ledger, track="crypto") ---
    // The 4th book: paper-copies BUYs from wallets discovered by mining crypto
    // markets (sources includes "crypto-market"), within the calculated crypto
    // entry band (55–75¢) — above the coin-flip and below expensive favorites.
    // Fixed $5. Its own rules; the exit is closed by the SELL block above when
    // the wallet sells. Never touches core/live/trade stats.
    const isCryptoWallet = (wallet?.sources ?? "").includes("crypto-market");
    const cryptoDrift = book?.bestAsk != null ? Math.abs(book.bestAsk - obs.walletEntryPrice) : null;
    // Eligibility: EITHER a proven holder OR a proven quota-trader — see
    // isCryptoBookEligible for why (2026-07-14 fix).
    const cryptoWalletProven = wallet
      ? isCryptoBookEligible(wallet, cryptoRules.minWalletGlobalScore)
      : false;
    if (
      isCryptoWallet &&
      obs.side === "BUY" &&
      book &&
      cryptoWalletProven &&
      book.bestAsk !== null &&
      book.bestAsk >= cryptoRules.minEntryPrice &&
      book.bestAsk <= cryptoRules.maxEntryPrice &&
      (cryptoDrift === null || cryptoDrift <= cryptoRules.maxPriceDrift) &&
      (book.spread === null || book.spread <= cryptoRules.maxSpread) &&
      (liquidity === null || liquidity >= cryptoRules.minLiquidity)
    ) {
      const cryptoDup = [
        eq(paperTrades.status, "open"),
        eq(paperTrades.track, "crypto"),
        eq(paperTrades.marketId, obs.marketId),
      ];
      if (obs.outcome) cryptoDup.push(eq(paperTrades.outcome, obs.outcome));
      const cryptoOpen = db.select({ id: paperTrades.id }).from(paperTrades).where(and(...cryptoDup)).get();
      if (!cryptoOpen) {
        const cryptoTrade = openPaperTrade(db, {
          decisionJournalId: journalId,
          walletAddress: obs.walletAddress,
          marketId: obs.marketId,
          tokenId: obs.tokenId,
          marketQuestion: market?.question ?? obs.marketQuestion,
          outcome: obs.outcome,
          usdSize: cryptoRules.minPositionSize,
          book,
          track: "crypto",
          now,
        });
        if (cryptoTrade.opened) {
          reasons.push(`crypto book: opened $${cryptoRules.minPositionSize.toFixed(2)} crypto copy (parallel ledger)`);
          if (telegramConfigured()) {
            const q = escapeHtml((market?.question ?? obs.marketQuestion ?? obs.marketId).slice(0, 120));
            await sendTelegramMessage(
              `₿ <b>LIBRO CRIPTO — copia en papel</b>\n${q}\n` +
                `Billetera ${obs.walletAddress.slice(0, 10)}… · entrada $${cryptoRules.minPositionSize.toFixed(2)} a ` +
                `${cryptoTrade.fill.avgFillPrice !== null ? (cryptoTrade.fill.avgFillPrice * 100).toFixed(1) : "?"}¢\n` +
                `(banda 55–75¢ · cerramos cuando la billetera venda — libro aparte)`,
            );
          }
          await maybeOpenEliteMirror(db, {
            arm: "crypto",
            journalId,
            walletAddress: obs.walletAddress,
            marketId: obs.marketId,
            tokenId: obs.tokenId,
            marketQuestion: market?.question ?? obs.marketQuestion,
            outcome: obs.outcome,
            book,
            now,
          });
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
        blockedGate: decision === "paper_copy" ? null : blockedGate,
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
    `decisions: ${counts.paper_copy} paper copies, ${counts.watchlist} watchlist, ${counts.skip} skips, ${counts.unfillable} unfillable, ${counts.exits} exits copied`,
  );
});
