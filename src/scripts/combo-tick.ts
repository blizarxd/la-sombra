import { and, desc, eq, gt, gte, like } from "drizzle-orm";
import { decisionJournal, observedTrades, paperTrades, walletProfiles } from "@/db/schema";
import { fetchWalletActivity, searchMarketByQuestion } from "@/lib/adapters";
import { comboLegCount, decideComboSettlement, type ComboActivityEvent } from "@/lib/combos";
import { isAffirmativeLeg, judgeAffirmativeLeg, splitComboLegs } from "@/lib/comboLegs";
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
 * - a LEG resolved against the pick  -> the parlay is dead -> LOST (leg-based,
 *   see comboLegs.ts — hours instead of the 7-day wait, assumption labeled).
 * - COMBO_LOSS_TIMEOUT (7d) passes   -> assume a leg missed -> LOST.
 *   The timeout is an honest, LABELED heuristic (page + journal note it).
 *
 * SAFETY: paper only. Reads public data, writes simulated positions. No orders.
 */

const COPY_LOOKBACK_MS = 26 * 3600 * 1000; // catch combos placed since ~yesterday's tick
const MIN_WALLET_STAKE_USD = 10; // Cup-qualifying stake = real conviction, not dust
const MAX_LEGS = 12; // beyond this it's a lottery ticket regardless of price
// Raised 15 -> 30 on 2026-07-16 (Johan): the book filled to 15/15 in its first
// real day and stopped taking signals. Leg-based loss settlement (below) now
// frees dead slots in hours instead of 7 days, so a bigger ceiling no longer
// means capital parked forever in losers. Still $5 fixed = $150 max at risk.
const MAX_OPEN_COMBOS = 30; // capital-parked ceiling for the whole book
const MAX_OPEN_PER_WALLET = 5; // diversification: one prolific bettor can't eat the whole book
// Leg-check budget per tick: each never-seen leg costs one public-search call.
// Questions repeat across combos (same games), so a small per-tick budget with
// a cache covers the whole book within a couple of ticks.
const MAX_LEG_LOOKUPS_PER_TICK = 40;
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
        const { realizedPnl } = resolvePaperTrade(db, t, false, now);
        log.info(`combo LOST (timeout heuristic) ${t.id.slice(0, 8)}… $${realizedPnl.toFixed(2)}`);
        await tg(`❌ <b>COMBO PERDIDO</b> (papel) 🧩\n${escapeHtml(label)}\nPnL $${realizedPnl.toFixed(2)} — sin redeem en 7 días (heurística etiquetada)`);
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
            "loss: a leg resolved against the pick (assumes affirmative side) or 7-day-no-redeem timeout",
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
  const legCache = new Map<string, Awaited<ReturnType<typeof searchMarketByQuestion>>>();
  let legLookups = 0;
  for (const t of openCombos) {
    if (settledIds.has(t.id)) continue;
    const legs = splitComboLegs(t.marketQuestion);
    if (legs.length < 2) continue;
    let lostLeg: string | null = null;
    for (const leg of legs) {
      if (!isAffirmativeLeg(leg)) continue; // side unreadable from the title — never judge it
      const key = leg.trim().toLowerCase();
      let market = legCache.get(key);
      if (market === undefined) {
        if (legLookups >= MAX_LEG_LOOKUPS_PER_TICK) break; // budget spent — next tick continues
        legLookups++;
        try {
          market = await searchMarketByQuestion(leg);
        } catch (err) {
          // Real API failure: skip this leg this tick, never guess a verdict.
          log.warn(`leg search failed for "${leg.slice(0, 60)}": ${err instanceof Error ? err.message : err}`);
          continue;
        }
        legCache.set(key, market);
      }
      if (market && judgeAffirmativeLeg(market) === "lost") {
        lostLeg = leg;
        break;
      }
    }
    if (!lostLeg) continue;
    const { realizedPnl } = resolvePaperTrade(db, t, false, now);
    settled++;
    openCount--;
    settledIds.add(t.id);
    const label = (t.marketQuestion ?? t.marketId).slice(0, 120);
    log.info(`combo LOST (leg resolved against) ${t.id.slice(0, 8)}… $${realizedPnl.toFixed(2)} — "${lostLeg.slice(0, 60)}"`);
    await tg(
      `❌ <b>COMBO PERDIDO</b> (papel) 🧩\n${escapeHtml(label)}\n` +
        `PnL $${realizedPnl.toFixed(2)} — pata resuelta en contra: «${escapeHtml(lostLeg.slice(0, 80))}»\n` +
        `(liquidación por patas: asume el lado afirmativo de cada pata, ver /combos)`,
    );
  }

  log.info(`combo tick: ${opened} copied, ${settled} settled (${legLookups} leg lookups), ${openCount} open`);
});

async function tg(html: string): Promise<void> {
  if (!telegramConfigured()) return;
  try {
    await sendTelegramMessage(html);
  } catch (err) {
    log.warn(`telegram send failed: ${err instanceof Error ? err.message : err}`);
  }
}
