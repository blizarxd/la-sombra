import Link from "next/link";
import { getDb } from "@/db/client";
import { getEliteBookStats, getRealizedPnlSeries } from "@/lib/queries";
import { money, pct, shortAddr, when } from "@/lib/format";
import { Card, Empty, Stat, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";

export const dynamic = "force-dynamic";

const ARM_LABELS: Record<string, string> = {
  core: "Pre-partido",
  live: "En Vivo",
  trade: "Cuota",
  crypto: "Cripto",
};

export default function ElitePage() {
  const db = getDb();
  const elite = getEliteBookStats(db);
  const realizedSeries = getRealizedPnlSeries(db, "elite");
  const pnlTone = elite.totalPnl > 0 ? "profit" : elite.totalPnl < 0 ? "loss" : "neutral";

  const rows: TradeRowData[] = elite.trades.map((t) => ({
    id: t.id,
    openedAtMs: t.openedAt.getTime(),
    market: t.marketQuestion ?? t.marketId,
    outcome: t.outcome,
    side: t.side,
    walletAddress: t.walletAddress,
    size: t.simulatedPositionSize,
    entryPrice: t.entryPrice,
    currentPrice: t.currentPrice,
    pnl: t.status !== "open" ? t.realizedPnl : t.unrealizedPnl,
    status: t.status,
  }));

  const arms = ["core", "live", "trade", "crypto"] as const;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🏆 La Crema — solo lo mejor de lo mejor</h1>
        <p className="text-sm text-mist">
          Sexto libro. No tiene reglas de entrada propias: cuando Pre-partido, En Vivo, Cuota o Cripto YA deciden
          copiar una jugada (ya pasó el filtro de ese brazo), y la billetera de origen es <b>top-10 semanal de ESE
          brazo</b> por PnL realizado en papel, La Crema abre el mismo trade en su propio libro. Nos copiamos a
          nosotros mismos, pero solo la porción confirmada ganadora. Roster se recalcula 1 vez al día — solo
          billeteras con PnL positivo la última semana entran; una mala semana y caen del roster solas. $5 fijo.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="PnL de la crema"
          value={money(elite.totalPnl, { sign: true })}
          tone={pnlTone}
          hint={`realizado ${money(elite.realizedPnl)} · abierto ${money(elite.unrealizedPnl)}`}
        />
        <Stat label="Tasa de acierto" value={pct(elite.winRate)} hint={`${elite.settledCount} liquidadas`} />
        <Stat label="Posiciones abiertas" value={String(elite.openCount)} />
        <Stat
          label="Roster actual"
          value={String(elite.rosterSize)}
          hint={elite.lastRefreshedAt ? `actualizado ${when(elite.lastRefreshedAt)}` : "aún no se ha calculado"}
        />
      </div>

      <Card title="PnL realizado de la crema (libro paralelo)">
        <PnlChart marked={realizedSeries} realized={realizedSeries} />
      </Card>

      <Card title={`Copias de la crema (${elite.trades.length})`}>
        <PaginatedTradesTable
          rows={rows}
          columns={["opened", "market", "wallet", "size", "entry", "current", "pnl", "status"]}
          emptyHint="Aún no hay copias. La crema abre cuando uno de los otros 4 brazos copia a una billetera que está en su top-10 semanal — necesita que el roster se calcule (1 vez al día) y que ese brazo genere una señal fresca de una billetera en el roster."
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {arms.map((arm) => {
          const wallets = elite.rosterByArm.get(arm) ?? [];
          return (
            <Card key={arm} title={`Top-10 semanal — ${ARM_LABELS[arm]}`}>
              {wallets.length === 0 ? (
                <Empty>Aún sin roster para este brazo (necesita copias liquidadas con PnL positivo en los últimos 7 días).</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <Th className="text-right">#</Th>
                        <Th>Billetera</Th>
                        <Th className="text-right">PnL 7d</Th>
                        <Th className="text-right">Trades</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {wallets.map((w) => (
                        <tr key={w.id} className="border-t border-edge">
                          <Td className="text-right text-mist">{w.rank}</Td>
                          <Td>
                            <Link href={`/wallets/${w.walletAddress}`} className="text-accent hover:underline">
                              {shortAddr(w.walletAddress)}
                            </Link>
                          </Td>
                          <Td className="text-right text-profit">{money(w.weeklyPnl, { sign: true })}</Td>
                          <Td className="text-right">{w.weeklyTradeCount}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <div className="text-xs text-mist">
        Nota honesta: esto no filtra señales nuevas — es un experimento sobre si SEGUIR SOLO A GANADORES CONFIRMADOS
        (sin analizar cada trade individual) rinde mejor que el filtrado caso-por-caso que hacen los otros brazos.
        Si el rendimiento de la crema no supera al del brazo de origen, la respuesta es que la selección de
        billetera por sí sola no basta — y eso también es un resultado. Solo papel, nunca órdenes reales.
      </div>
    </div>
  );
}
