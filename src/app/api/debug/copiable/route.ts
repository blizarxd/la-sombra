import { inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { categorizeMarket } from "@/lib/category";

/**
 * TEMPORARY: is the capital book manually copyable at all?
 *
 * The operator tick runs every 20 minutes, so a human watching the page sees a
 * position some time AFTER it was recorded. If the underlying markets settle
 * faster than that window, the answer is no in principle — the market would be
 * over before anyone could act. Measures three things end to end:
 *
 *   1. detection lag  — wallet's own trade -> our paper copy opening
 *   2. hold time      — our entry -> settle, per category
 *   3. survival       — % still open 20/30/60 min after our entry
 *
 * Read-only, no side effects. Delete once read.
 */
export async function GET() {
  const db = getDb();

  const trades = db
    .select({
      decisionJournalId: schema.paperTrades.decisionJournalId,
      marketQuestion: schema.paperTrades.marketQuestion,
      status: schema.paperTrades.status,
      openedAt: schema.paperTrades.openedAt,
      closedAt: schema.paperTrades.closedAt,
      resolvedAt: schema.paperTrades.resolvedAt,
    })
    .from(schema.paperTrades)
    .where(ne(schema.paperTrades.track, "elite"))
    .all()
    .filter((t) => t.status !== "open");

  // paper trade -> journal -> observed trade (carries the wallet's own timestamp)
  const jIds = [...new Set(trades.map((t) => t.decisionJournalId))];
  const journals = jIds.length
    ? db
        .select({ id: schema.decisionJournal.id, observedTradeId: schema.decisionJournal.observedTradeId })
        .from(schema.decisionJournal)
        .where(inArray(schema.decisionJournal.id, jIds))
        .all()
    : [];
  const oIds = [...new Set(journals.map((j) => j.observedTradeId))];
  const observed = oIds.length
    ? db
        .select({ id: schema.observedTrades.id, timestamp: schema.observedTrades.timestamp })
        .from(schema.observedTrades)
        .where(inArray(schema.observedTrades.id, oIds))
        .all()
    : [];
  const obsById = new Map(observed.map((o) => [o.id, o]));
  const jById = new Map(journals.map((j) => [j.id, j]));

  const pctl = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  const byCat = new Map<string, { holds: number[]; lags: number[] }>();
  for (const t of trades) {
    const end = t.resolvedAt ?? t.closedAt;
    if (!end) continue;
    const cat = categorizeMarket(t.marketQuestion);
    const acc = byCat.get(cat) ?? { holds: [], lags: [] };
    acc.holds.push((end.getTime() - t.openedAt.getTime()) / 60_000); // minutes
    const j = jById.get(t.decisionJournalId);
    const o = j ? obsById.get(j.observedTradeId) : undefined;
    if (o) acc.lags.push((t.openedAt.getTime() - o.timestamp.getTime()) / 60_000);
    byCat.set(cat, acc);
  }

  const out = [...byCat.entries()]
    .filter(([, v]) => v.holds.length >= 10)
    .map(([cat, v]) => ({
      categoria: cat,
      n: v.holds.length,
      retencionMin: {
        p10: pctl(v.holds, 0.1),
        mediana: pctl(v.holds, 0.5),
        p90: pctl(v.holds, 0.9),
      },
      // The decisive numbers: could a human acting N minutes late still enter?
      sigueAbiertaTras20min: v.holds.filter((h) => h > 20).length / v.holds.length,
      sigueAbiertaTras30min: v.holds.filter((h) => h > 30).length / v.holds.length,
      sigueAbiertaTras60min: v.holds.filter((h) => h > 60).length / v.holds.length,
      retrasoDeteccionMin: {
        n: v.lags.length,
        mediana: pctl(v.lags, 0.5),
        p90: pctl(v.lags, 0.9),
      },
    }))
    .sort((a, b) => b.n - a.n);

  return Response.json({ intervaloTickMin: 20, categorias: out });
}
