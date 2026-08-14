import { eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";
import { isFastFormatMarket } from "@/lib/fastFormat";

/**
 * TEMPORARY research dump: which signal available AT ENTRY actually predicts
 * that a market settles in under an hour?
 *
 * Two candidates have already failed: Polymarket's end_date (15% coverage,
 * mostly nonsense) and a text-format classifier (87% of its matches took ~5h).
 * This measures the remaining ones against the real settle times we recorded —
 * chiefly the in-play flag, which says the game had ALREADY STARTED when the
 * copy was made, and is the obvious missing ingredient: "Game 2 Winner" is
 * tradeable hours before Game 2 begins, but not once it is under way.
 *
 * Read-only, no side effects, not linked from any page. Delete once answered.
 */
export async function GET() {
  const db = getDb();

  const trades = db
    .select({
      id: schema.paperTrades.id,
      decisionJournalId: schema.paperTrades.decisionJournalId,
      marketQuestion: schema.paperTrades.marketQuestion,
      simulatedPositionSize: schema.paperTrades.simulatedPositionSize,
      realizedPnl: schema.paperTrades.realizedPnl,
      status: schema.paperTrades.status,
      openedAt: schema.paperTrades.openedAt,
      closedAt: schema.paperTrades.closedAt,
      resolvedAt: schema.paperTrades.resolvedAt,
    })
    .from(schema.paperTrades)
    .where(ne(schema.paperTrades.track, "elite"))
    .all()
    .filter((t) => t.status !== "open" && t.realizedPnl !== null);

  // paper trade -> decision journal -> observed trade (which carries inPlay)
  const journalIds = [...new Set(trades.map((t) => t.decisionJournalId))];
  const journals = journalIds.length
    ? db
        .select({ id: schema.decisionJournal.id, observedTradeId: schema.decisionJournal.observedTradeId })
        .from(schema.decisionJournal)
        .where(inArray(schema.decisionJournal.id, journalIds))
        .all()
    : [];
  const obsIds = [...new Set(journals.map((j) => j.observedTradeId))];
  const observed = obsIds.length
    ? db
        .select({ id: schema.observedTrades.id, inPlay: schema.observedTrades.inPlay })
        .from(schema.observedTrades)
        .where(inArray(schema.observedTrades.id, obsIds))
        .all()
    : [];
  const obsById = new Map(observed.map((o) => [o.id, o]));
  const journalById = new Map(journals.map((j) => [j.id, j]));

  type Bucket = { n: number; fast: number; wins: number; staked: number; pnl: number; durSum: number };
  const mk = (): Bucket => ({ n: 0, fast: 0, wins: 0, staked: 0, pnl: 0, durSum: 0 });
  const buckets = new Map<string, Bucket>();
  const add = (key: string, durH: number, r: (typeof trades)[number]) => {
    const b = buckets.get(key) ?? mk();
    b.n += 1;
    if (durH < 1) b.fast += 1;
    if ((r.realizedPnl ?? 0) > 0) b.wins += 1;
    b.staked += r.simulatedPositionSize;
    b.pnl += r.realizedPnl ?? 0;
    b.durSum += durH;
    buckets.set(key, b);
  };

  let inPlayKnown = 0;
  for (const t of trades) {
    const end = t.resolvedAt ?? t.closedAt;
    if (!end) continue;
    const durH = (end.getTime() - t.openedAt.getTime()) / 3_600_000;
    const cat = categorizeMarket(t.marketQuestion);
    if (cat !== "esports" && cat !== "deportes") continue;

    const j = journalById.get(t.decisionJournalId);
    const o = j ? obsById.get(j.observedTradeId) : undefined;
    const inPlay = o?.inPlay ?? null;
    if (inPlay !== null) inPlayKnown += 1;
    const fmt = isFastFormatMarket(t.marketQuestion);

    const ip = inPlay === null ? "desconocido" : inPlay ? "EN JUEGO" : "pre-partido";
    add(`${cat} | ${ip} | ${fmt ? "formato-rapido" : "formato-normal"}`, durH, t);
    add(`SOLO-INPLAY: ${ip}`, durH, t);
    add(`SOLO-FORMATO: ${fmt ? "formato-rapido" : "formato-normal"}`, durH, t);
  }

  const out = [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      n: b.n,
      pctUnder1h: b.n ? (100 * b.fast) / b.n : 0,
      avgDurationH: b.n ? b.durSum / b.n : 0,
      winRate: b.n ? b.wins / b.n : 0,
      roiPct: b.staked ? (100 * b.pnl) / b.staked : 0,
      pnl: Math.round(b.pnl * 100) / 100,
    }))
    .filter((r) => r.n >= 15)
    .sort((a, b) => b.pctUnder1h - a.pctUnder1h);

  return Response.json({ tradesConsidered: trades.length, inPlayKnown, buckets: out });
}
