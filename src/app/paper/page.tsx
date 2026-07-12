import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { decisionJournal, paperTrades } from "@/db/schema";
import { getFillRateStats } from "@/lib/queries";
import { isDemo, money, parseJsonList, pct, price, shortAddr, when } from "@/lib/format";
import { Badge, DemoTag, Empty, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

export default function PaperTradesPage() {
  const db = getDb();
  // Core ledger only — the ⚡ live experiment has its own page and books.
  const trades = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.track, "core"))
    .orderBy(desc(paperTrades.openedAt))
    .limit(200)
    .all();
  const decisions = trades.length
    ? db
        .select()
        .from(decisionJournal)
        .where(inArray(decisionJournal.id, trades.map((t) => t.decisionJournalId)))
        .all()
    : [];
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const fill = getFillRateStats(db);

  const realized = trades.filter((t) => t.status !== "open").reduce((a, t) => a + (t.realizedPnl ?? 0), 0);
  const unrealized = trades.filter((t) => t.status === "open").reduce((a, t) => a + (t.unrealizedPnl ?? 0), 0);
  const spreadPaid = trades.reduce((a, t) => a + (t.spreadCostPaid ?? 0), 0);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Trades en papel</h1>
        <p className="text-sm text-mist">
          Posiciones simuladas ($5–$20 según confianza). Las entradas se llenan al ask real; las salidas se valoran al bid — se paga el spread, como en la realidad.
          {" "}Las copias del experimento en vivo llevan su propio libro en <Link href="/live" className="text-accent hover:underline">⚡ En Vivo</Link>.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="PnL realizado" value={money(realized, { sign: true })} tone={realized >= 0 ? "profit" : "loss"} />
        <Stat label="PnL no realizado" value={money(unrealized, { sign: true })} tone={unrealized >= 0 ? "profit" : "loss"} />
        <Stat label="Tasa de llenado (realismo)" value={pct(fill.fillRate)} hint={`${fill.filled}/${fill.copyDecisions} decisiones de copia llenadas, ${fill.unfillable} sin llenar`} />
        <Stat label="Costo de spread pagado" value={money(spreadPaid)} hint="impuesto de honestidad en todas las entradas" />
      </div>

      {trades.length === 0 ? (
        <Empty>Aún no hay trades en papel. Los crea <code className="text-accent">npm run score:trades</code> cuando una señal supera el umbral de copia.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Abierto</Th>
              <Th>Mercado</Th>
              <Th>Billetera</Th>
              <Th className="text-right">Tamaño</Th>
              <Th className="text-right">Entrada</Th>
              <Th className="text-right">Actual</Th>
              <Th className="text-right">PnL</Th>
              <Th>Estado</Th>
              <Th>Motivo de entrada</Th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const d = decisionById.get(t.decisionJournalId);
              const pnl = t.status !== "open" ? t.realizedPnl : t.unrealizedPnl;
              const reasons = d ? parseJsonList(d.reasonsJson) : [];
              return (
                <tr key={t.id}>
                  <Td className="whitespace-nowrap text-mist">{when(t.openedAt)}</Td>
                  <Td className="max-w-80">
                    {t.marketQuestion ?? t.marketId}
                    {isDemo(t.marketQuestion) ? <span className="ml-1"><DemoTag /></span> : null}
                    <div className="text-[11px] text-mist">{t.outcome ?? ""} · {t.side}</div>
                  </Td>
                  <Td>
                    <Link href={`/wallets/${t.walletAddress}`} className="text-accent hover:underline">
                      {shortAddr(t.walletAddress)}
                    </Link>
                  </Td>
                  <Td className="text-right">{money(t.simulatedPositionSize)}</Td>
                  <Td className="text-right">{price(t.entryPrice)}</Td>
                  <Td className="text-right">{price(t.currentPrice)}</Td>
                  <Td className="text-right font-semibold"><PnlText value={pnl} /></Td>
                  <Td><Badge value={t.status} /></Td>
                  <Td className="max-w-72 text-xs text-mist">{reasons[0] ?? "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
