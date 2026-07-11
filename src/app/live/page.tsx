import Link from "next/link";
import { getDb } from "@/db/client";
import { getLiveStats, getPnlSeries } from "@/lib/queries";
import { money, pct, price, score, shortAddr, when } from "@/lib/format";
import { Badge, Card, Empty, PnlText, Stat, Table, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";

export const dynamic = "force-dynamic";

export default function LivePage() {
  const db = getDb();
  const live = getLiveStats(db);
  const series = getPnlSeries(db, "live");
  const pnlTone = live.totalPnl > 0 ? "profit" : live.totalPnl < 0 ? "loss" : "neutral";

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">⚡ En Vivo — experimento paralelo</h1>
        <p className="text-sm text-mist">
          Copias en papel de apuestas hechas con el juego YA EN MARCHA. Libro totalmente separado de la
          estrategia principal: tamaño fijo de $5, sin guardia de deriva (lo que se mide es justamente si
          llegar tarde al precio en vivo mata el edge). Nada de aquí toca las estadísticas del resto del panel.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="PnL del experimento" value={money(live.totalPnl, { sign: true })} tone={pnlTone} hint={`realizado ${money(live.realizedPnl)} · abierto ${money(live.unrealizedPnl)}`} />
        <Stat label="Tasa de acierto (vivo)" value={pct(live.winRate)} hint={`${live.resolvedCount} resueltas`} />
        <Stat label="Posiciones abiertas" value={String(live.openCount)} />
        <Stat label="Señales en vivo hoy" value={String(live.liveSignalsToday)} />
      </div>

      <Card title="PnL del experimento en vivo (libro paralelo)">
        <PnlChart points={series} />
      </Card>

      <Card title={`Copias en vivo (${live.trades.length})`}>
        {live.trades.length === 0 ? (
          <Empty>
            Aún no hay copias en vivo. Se abren solas cuando una billetera seguida de calidad apuesta con el
            juego en marcha y el mercado pasa banda de precio, spread y liquidez.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Abierta</Th>
                <Th>Mercado</Th>
                <Th>Billetera</Th>
                <Th className="text-right">Tamaño</Th>
                <Th className="text-right">Entrada</Th>
                <Th className="text-right">Actual</Th>
                <Th className="text-right">PnL</Th>
                <Th>Estado</Th>
              </tr>
            </thead>
            <tbody>
              {live.trades.map((t) => {
                const pnl = t.status === "resolved" ? t.realizedPnl : t.unrealizedPnl;
                return (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap text-mist">{when(t.openedAt)}</Td>
                    <Td className="max-w-80">
                      {t.marketQuestion ?? t.marketId}
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
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Billeteras con historial en vivo (mín. 5 resueltas)">
          {live.liveWallets.length === 0 ? (
            <Empty>Todavía ninguna billetera perfilada muestra historial en vivo suficiente.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {live.liveWallets.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge value={w.status} />
                    <Link href={`/wallets/${w.address}`} className="text-accent hover:underline">
                      {w.label ?? shortAddr(w.address)}
                    </Link>
                  </span>
                  <span className="text-mist">
                    vivo <span className="font-semibold text-bright">{pct(w.liveWinRate30d)}</span>
                    {" · "}general {pct(w.winRate30d)}
                    {" · "}{w.liveResolvedCount30d} resueltas · ROI vivo {pct(w.liveRoi30d)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Últimas señales en vivo detectadas">
          {live.liveSignals.length === 0 ? (
            <Empty>El loop rápido aún no ha clasificado señales en vivo.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {live.liveSignals.slice(0, 12).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="max-w-64 truncate">{s.marketQuestion ?? s.marketId}</span>
                  <span className="whitespace-nowrap text-xs text-mist">
                    {shortAddr(s.walletAddress)} · {price(s.walletEntryPrice)} · {when(s.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="text-xs text-mist">
        Nota honesta: este experimento existe para responder con datos si copiar en vivo es viable. Si el PnL
        de este libro es consistentemente negativo, la respuesta es «no» y eso también es un resultado valioso.
      </div>
    </div>
  );
}
