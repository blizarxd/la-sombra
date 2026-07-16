import { and, desc, eq, gt, gte, like } from "drizzle-orm";
import { comboLegResolutions, decisionJournal, observedTrades, paperTrades, walletProfiles } from "@/db/schema";
import { fetchWalletActivity, searchMarketByQuestion } from "@/lib/adapters";
import { comboLegCount, decideComboSettlement, type ComboActivityEvent } from "@/lib/combos";
import { decideComboByLegs, isAffirmativeLeg, judgeAffirmativeLeg, splitComboLegs, type LegState } from "@/lib/comboLegs";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import { closePaperTradeAtPrice, openPaperTradeAtPrice, resolvePaperTrade } from "@/lib/paper/engine";
import { getActiveRules } from "@/lib/rules";
import { escapeHtml, sendTelegramMessage, telegramConfigured } from "@/lib/telegram";
import { runScript } from "./_runner";

/**
 * 🧩 COMBO BOOK tick (5th parallel ledger, track="combo").
 *
 * Copies whole COMBOS (parlays) — treated as a single pick — from wallets that
 * surfaced on the Combo Cup leaderboard AND show positive combo cashflow over
 * 30d (profile-combo-wallets). One board win alone never qualifies a wallet:
 * that is survivorship bias, the exact trap this gate exists to avoid.
 *
 * Settlement (combos have no public order book — they trade via RFQ):
 * - source wallet REDEEMs the combo  -> every leg hit -> WON (payout = shares).
 * - source wallet SELLs (cash-out)   -> we copy the exit at their price.
 * - LOSS is decided from the LEGS (see comboLegs.ts): a readable leg resolved
 *   against the pick, or every leg settled with no claim past a MEASURED grace
 *   window. Replaced the old flat 7-day-since-buy timeout, which waited a week
 *   on games that finished yesterday and falsely killed combos whose last leg
 *   was still days away.
 *
 * SAFETY: paper only. Reads public data, writes simulated positions. No orders.
 */

/**
 * How stale a wallet's combo may be and still be worth copying.
 *
 * Was 26h — indefensible, and it bit on 2026-07-16. This tick runs every 20
 * minutes, so in normal operation the measured copy lag is 0-2.3h; the 26h
 * window never showed. Then the fast lane jammed for hours that morning, and
 * when it recovered the book copied a whole day's backlog at once — bets on
 * games that had ALREADY BEEN PLAYED, entered at the wallet's price from the
 * day before. That is not copy trading, it is time travel, and every one of
 * those rows is a copy we could never have made.
 *
 * 2h is generous against a 20-minute tick and still bounded by the leg guard
 * below, which is the rigorous check.
 */
const COPY_LOOKBACK_MS = 2 * 3600 * 1000;
const MIN_WALLET_STAKE_USD = 10; // Cup-qualifying stake = real conviction, not dust
const MAX_LEGS = 12; // beyond this it's a lottery ticket regardless of price
// Ceiling on simultaneously open combos. 15 -> 30 -> 120 over 2026-07-16.
//
// This book is PAPER, so the cap was never about risk — nothing is at stake.
// What it really bounds is SETTLEMENT THROUGHPUT: every open combo has to be
// checked against its legs, and each unseen leg costs one gamma call. When leg
// resolutions were re-fetched every tick, a full book burned the whole lookup
// budget on games that had finished days earlier and the combos at the back of
// the queue were never evaluated at all — the cap was really a disguise for
// that bottleneck. Resolutions are now cached permanently in the DB
// (combo_leg_resolutions: closed + uma-resolved is final and never changes), so
// a leg costs at most ONE call in its lifetime and the budget only pays for
// genuinely new games. That is what makes a much bigger book affordable.
//
// It is not unlimited on purpose: a cap keeps the book a simulation of
// something a person could plausibly run, keeps the per-tick work bounded, and
// makes "the book is full" a visible signal rather than silent unbounded
// growth. MAX_OPEN_PER_WALLET still does the diversification work.
const MAX_OPEN_COMBOS = 120;
const MAX_OPEN_PER_WALLET = 5; // diversification: one prolific bettor can't eat the whole book
// Budget for legs we have NEVER resolved before (cached ones are free). Sized
// for a day's worth of fresh games, not for the whole open book.
const MAX_LEG_LOOKUPS_PER_TICK = 60;
const MIN_COMBO_BUYS_30D = 3; // eligibility: enough combo history to judge
const ELIGIBLE_WALLET_LIMIT = 12; // API friendliness: top wallets by combo net PnL

runScript("combo:tick", async (db) => {
  const { rules, version: ruleVersion } = getActiveRules(db, "combo");
  const now = new Date();
  const nowMs = now.getTime();

  // --- who we follow: board wallets with positive, non-trivial combo cashflow ---
  const eligible = db
    .select()
    .from(walletProfiles)
    .where(
      and(
        like(walletProfiles.sources, "%combo-cup%"),
        eq(walletProfiles.benched, false),
        gt(walletProfiles.comboNetPnl30d, 0),
        gte(walletProfiles.comboTradeCount30d, MIN_COMBO_BUYS_30D),
      ),
    )
    .orderBy(desc(walletProfiles.comboNetPnl30d))
    .limit(ELIGIBLE_WALLET_LIMIT)
    .all();

  const openCombos = db
    .select()
    .from(paperTrades)
    .where(and(eq(paperTrades.track, "combo"), eq(paperTrades.status, "open")))
    .all();

  // One activity fetch per wallet serves BOTH settlement and copy detection.
  const wallets = new Map<string, { copyFrom: boolean; sinceMs: number }>();
  for (const w of eligible) {
    wallets.set(w.address, { copyFrom: true, sinceMs: nowMs - COPY_LOOKBACK_MS });
  }
  for (const t of openCombos) {
    const cur = wallets.get(t.walletAddress);
    const needSince = t.openedAt.getTime() - 3600 * 1000; // include the buy itself
    if (cur) cur.sinceMs = Math.min(cur.sinceMs, needSince);
    else wallets.set(t.walletAddress, { copyFrom: false, sinceMs: needSince });
  }
  if (wallets.size === 0) {
    log.info("combo book: no eligible wallets and no open combos yet — waiting on sourcing/profiling");
    return;
  }
  log.info(`combo book: ${eligible.length} eligible wallets, ${openCombos.length} open combos (rules v${ruleVersion})`);

  // Legs already known to be resolved: FREE, no API call, ever again. Loaded
  // once and shared by BOTH passes — the copy guard below and the loss pass.
  const cachedLegs = new Map(
    db
      .select()
      .from(comboLegResolutions)
      .all()
      .map((r) => [r.question, r]),
  );
  const tickCache = new Map<string, Awaited<ReturnType<typeof searchMarketByQuestion>>>();
  let legLookups = 0;
  let cacheHits = 0;

  /** Resolve a leg to its market, cache-first. null = unknown this tick. */
  async function legMarket(leg: string) {
    const key = leg.trim().toLowerCase();
    const hit = cachedLegs.get(key);
    if (hit) {
      cacheHits++;
      return { closed: true, umaResolutionStatus: "resolved", outcomes: hit.outcomesJson, outcomePricesJson: hit.outcomePricesJson, endDateMs: hit.endDateMs, cached: true as const };
    }
    if (tickCache.has(key)) {
      const m = tickCache.get(key)!;
      return m ? { ...m, outcomePricesJson: m.outcomePrices, cached: false as const } : null;
    }
    if (legLookups >= MAX_LEG_LOOKUPS_PER_TICK) return null;
    legLookups++;
    try {
      const m = await searchMarketByQuestion(leg);
      tickCache.set(key, m);
      if (m && m.closed && m.umaResolutionStatus === "resolved" && !cachedLegs.has(key)) {
        const row = { question: key, endDateMs: m.endDateMs, outcomesJson: m.outcomes, outcomePricesJson: m.outcomePrices, resolvedAt: now };
        db.insert(comboLegResolutions).values(row).onConflictDoNothing().run();
        cachedLegs.set(key, row);
      }
      return m ? { ...m, outcomePricesJson: m.outcomePrices, cached: false as const } : null;
    } catch (err) {
      log.warn(`leg search failed for "${leg.slice(0, 60)}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * True when a leg of this combo has ALREADY resolved — the game is played and
   * copying the bet now would be entering a race that is already over. The
   * freshness window above is a blunt instrument; this is the real check, and
   * it is what keeps a post-outage catch-up from filling the book with copies
   * we could never have made.
   */
  async function anyLegAlreadyResolved(title: string | null): Promise<string | null> {
    for (const leg of splitComboLegs(title)) {
      const m = await legMarket(leg);
      if (m && m.closed && m.umaResolutionStatus === "resolved") return leg;
    }
    return null;
  }

  let opened = 0;
  let settled = 0;
  let openCount = openCombos.length;
  const settledIds = new Set<string>();

  for (const [address, info] of wallets) {
    let events: ComboActivityEvent[];
    try {
      events = await fetchWalletActivity(address, { limit: 200, sinceMs: info.sinceMs });
    } catch (err) {
      // Real API failure: skip this wallet this tick, never invent activity.
      log.warn(`combo activity failed for ${address.slice(0, 10)}…: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    // --- settle open combos copied from this wallet ---
    for (const t of openCombos.filter((t) => t.walletAddress === address)) {
      const verdict = decideComboSettlement(
        { conditionId: t.marketId, openedAtMs: t.openedAt.getTime() },
        events,
        nowMs,
      );
      if (verdict.kind === "hold") continue;
      const label = (t.marketQuestion ?? t.marketId).slice(0, 120);
      if (verdict.kind === "win") {
        const { realizedPnl } = resolvePaperTrade(db, t, true, now);
        log.info(`combo WON ${t.id.slice(0, 8)}… +$${realizedPnl.toFixed(2)} (wallet redeemed)`);
        await tg(`✅ <b>COMBO GANADO</b> (papel) 🧩\n${escapeHtml(label)}\nPnL +$${realizedPnl.toFixed(2)} (entrada ${(t.entryPrice * 100).toFixed(1)}¢ = ${(1 / t.entryPrice).toFixed(1)}x)`);
      } else if (verdict.kind === "cashout") {
        const { realizedPnl } = closePaperTradeAtPrice(db, t, verdict.price, now);
        log.info(`combo CASH-OUT ${t.id.slice(0, 8)}… $${realizedPnl.toFixed(2)} at ${verdict.price.toFixed(3)}`);
        await tg(`🔁 <b>COMBO cerrado</b> — la billetera hizo cash-out 🧩\n${escapeHtml(label)}\nPnL $${realizedPnl.toFixed(2)} (salida a su precio ${(verdict.price * 100).toFixed(1)}¢)`);
      } else {
        // loss_timeout (7d since the BUY) is NO LONGER acted on here — the leg
        // pass below decides losses from the legs' real resolution instead.
        // Kept as a signal only: acting on it was wrong in both directions
        // (a week's wait on games that finished yesterday, and a false kill on
        // combos whose last leg was still days out).
        continue;
      }
      settled++;
      openCount--;
      settledIds.add(t.id);
    }

    // --- copy new combos from eligible wallets ---
    if (!info.copyFrom) continue;
    let walletOpen = openCombos.filter((t) => t.walletAddress === address && t.status === "open").length;
    for (const e of events) {
      if (!(e.type === "TRADE" && e.side === "BUY" && e.isCombo)) continue;
      if (e.timestampMs < nowMs - COPY_LOOKBACK_MS) continue;
      if (openCount >= MAX_OPEN_COMBOS || walletOpen >= MAX_OPEN_PER_WALLET) break;
      const legs = comboLegCount(e.title);
      const priceOk = e.price >= rules.minEntryPrice && e.price <= rules.maxEntryPrice;
      if (!priceOk || e.usdcSize < MIN_WALLET_STAKE_USD || legs < 2 || legs > MAX_LEGS) continue;

      const dedupeKey = `combo|${e.transactionHash ?? `${address}|${e.conditionId}|${e.timestampMs}`}`;
      const exists = db
        .select({ id: observedTrades.id })
        .from(observedTrades)
        .where(eq(observedTrades.dedupeKey, dedupeKey))
        .get();
      if (exists) continue;

      // Race-already-over guard: never copy a combo whose game has been played.
      // Checked AFTER the cheap filters and the dedupe so it only costs a
      // lookup for a bet we would otherwise actually take.
      const deadLeg = await anyLegAlreadyResolved(e.title);
      if (deadLeg) {
        log.warn(
          `combo SKIPPED — leg already resolved: "${deadLeg.slice(0, 60)}" (wallet bet ${((nowMs - e.timestampMs) / 3600_000).toFixed(1)}h ago)`,
        );
        continue;
      }

      // Concentration guard: wallets often LADDER the same legs several times
      // at different prices (seen live 2026-07-13). One copy per distinct
      // combo (same legs, same wallet) is enough — we track the pick, not
      // their position size.
      if (e.title) {
        const sameLegs = db
          .select({ id: paperTrades.id })
          .from(paperTrades)
          .where(
            and(
              eq(paperTrades.track, "combo"),
              eq(paperTrades.walletAddress, address),
              eq(paperTrades.marketQuestion, e.title),
            ),
          )
          .get();
        if (sameLegs) continue;
      }

      // Journal + observed row so the copy is auditable in /journal like every
      // other decision. scored=true keeps it out of the core scoring pipeline;
      // review-outcomes skips synthetic combo conditionIds by design.
      const observedId = newId();
      db.insert(observedTrades)
        .values({
          id: observedId,
          walletAddress: address,
          marketId: e.conditionId,
          conditionId: e.conditionId,
          tokenId: null,
          marketQuestion: e.title,
          marketCategory: "combo",
          outcome: `${legs} legs`,
          side: "BUY",
          walletEntryPrice: e.price,
          detectedPrice: e.price,
          size: e.usdcSize,
          inPlay: null,
          timestamp: new Date(e.timestampMs),
          dedupeKey,
          scored: true,
          rawTradeJson: JSON.stringify(e),
          createdAt: now,
        })
        .run();
      const journalId = newId();
      db.insert(decisionJournal)
        .values({
          id: journalId,
          observedTradeId: observedId,
          walletAddress: address,
          marketId: e.conditionId,
          decision: "paper_copy",
          copyScore: 0, // combo book decisions are gate-based, not score-based
          confidence: 0,
          reasonsJson: JSON.stringify([
            `combo book: wallet is Combo-Cup sourced with positive 30d combo cashflow`,
            `combined price ${(e.price * 100).toFixed(1)}¢ = ${(1 / e.price).toFixed(1)}x within band`,
            `${legs} legs · wallet staked $${e.usdcSize.toFixed(0)}`,
          ]),
          risksJson: JSON.stringify([
            "all legs must hit — a single miss loses the full stake",
            "no public book: entry copied at the wallet's executed RFQ price",
            "loss: a readable leg resolved against the pick, or every leg settled with no claim past a measured 12h grace",
          ]),
          simulatedPositionSize: rules.minPositionSize,
          blockedGate: null,
          ruleSetVersion: ruleVersion,
          createdAt: now,
        })
        .run();

      const result = openPaperTradeAtPrice(db, {
        decisionJournalId: journalId,
        walletAddress: address,
        marketId: e.conditionId,
        tokenId: null,
        marketQuestion: e.title,
        outcome: `${legs} legs`,
        usdSize: rules.minPositionSize,
        price: e.price,
        track: "combo",
        now,
      });
      if (result.opened) {
        opened++;
        openCount++;
        walletOpen++;
        log.info(
          `combo copy ${result.paperTradeId?.slice(0, 8)}… ${legs} legs at ${(e.price * 100).toFixed(1)}¢ (${(1 / e.price).toFixed(1)}x) from ${address.slice(0, 10)}…`,
        );
        await tg(
          `🧩 <b>LIBRO COMBO — copia en papel</b>\n${escapeHtml((e.title ?? "").slice(0, 160))}\n` +
            `${legs} patas · ${(1 / e.price).toFixed(1)}x · entrada $${rules.minPositionSize.toFixed(2)} a ${(e.price * 100).toFixed(1)}¢\n` +
            `Billetera ${address.slice(0, 10)}… (Combo Cup, cashflow 30d positivo) — libro aparte, solo papel`,
        );
      }
    }
  }
  // --- leg-based LOSS pass (see comboLegs.ts) ---------------------------------
  // For combos the wallet neither redeemed nor sold: judge each affirmative
  // leg against its real gamma market. One leg resolved against the pick kills
  // the parlay -> deterministic LOSS in hours, freeing the slot, instead of
  // the 7-day timeout. WINS are never decided here — only REDEEM proves a win.
  // (cachedLegs / tickCache / legMarket are declared above — the copy guard and
  // this pass share one cache and one lookup budget.)
  for (const t of openCombos) {
    if (settledIds.has(t.id)) continue;
    const legTitles = splitComboLegs(t.marketQuestion);
    if (legTitles.length < 2) continue;

    const legs: LegState[] = [];
    let budgetHit = false;
    for (const leg of legTitles) {
      const m = await legMarket(leg);
      if (m === null && legLookups >= MAX_LEG_LOOKUPS_PER_TICK) {
        budgetHit = true;
        break; // budget spent — next tick continues where this one stopped
      }
      legs.push({
        question: leg,
        resolved: m ? Boolean(m.closed && m.umaResolutionStatus === "resolved") : null,
        endDateMs: m?.endDateMs ?? null,
        // Only "Will …?" legs carry a readable side; everything else stays unknown.
        outcome:
          m && isAffirmativeLeg(leg)
            ? judgeAffirmativeLeg({
                closed: m.closed,
                umaResolutionStatus: m.umaResolutionStatus,
                outcomes: m.outcomes,
                outcomePrices: m.outcomePricesJson,
              })
            : "unknown",
      });
    }
    if (budgetHit) continue;

    const verdict = decideComboByLegs(legs, nowMs);
    if (verdict.kind === "hold") continue;

    const { realizedPnl } = resolvePaperTrade(db, t, false, now);
    settled++;
    openCount--;
    settledIds.add(t.id);
    const label = (t.marketQuestion ?? t.marketId).slice(0, 120);
    if (verdict.kind === "lost_leg") {
      log.info(`combo LOST (leg resolved against) ${t.id.slice(0, 8)}… $${realizedPnl.toFixed(2)} — "${verdict.leg.slice(0, 60)}"`);
      await tg(
        `❌ <b>COMBO PERDIDO</b> (papel) 🧩\n${escapeHtml(label)}\n` +
          `PnL $${realizedPnl.toFixed(2)} — pata resuelta en contra: «${escapeHtml(verdict.leg.slice(0, 80))}»`,
      );
    } else {
      log.info(
        `combo LOST (all legs settled ${verdict.hoursSinceResolved.toFixed(0)}h ago, never claimed) ${t.id.slice(0, 8)}… $${realizedPnl.toFixed(2)}`,
      );
      await tg(
        `❌ <b>COMBO PERDIDO</b> (papel) 🧩\n${escapeHtml(label)}\n` +
          `PnL $${realizedPnl.toFixed(2)} — todas las patas resueltas hace ${verdict.hoursSinceResolved.toFixed(0)}h y la billetera nunca cobró\n` +
          `(los ganadores cobran en ~2-4h; medido, ver /combos)`,
      );
    }
  }

  log.info(
    `combo tick: ${opened} copied, ${settled} settled, ${openCount}/${MAX_OPEN_COMBOS} open ` +
      `(legs: ${cacheHits} cached / ${legLookups} fetched)`,
  );
});

async function tg(html: string): Promise<void> {
  if (!telegramConfigured()) return;
  try {
    await sendTelegramMessage(html);
  } catch (err) {
    log.warn(`telegram send failed: ${err instanceof Error ? err.message : err}`);
  }
}
