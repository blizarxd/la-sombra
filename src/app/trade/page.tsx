import Link from "next/link";
import { getDb } from "@/db/client";
import { getPnlSeries, getRealizedPnlSeries, getTradeStats, getWalletPaperPerformance } from "@/lib/queries";
import { money, pct, price, shortAddr, when } from "@/lib/format";
import { Badge, Card, Empty, PnlText, Stat, Table, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";

export const dynamic = "force-dynamic";

export default function TradePage() {
  const db = getDb();
  const trade = getTradeStats(db);
  const series = getPnlSeries(db, "trade");
  const realizedSeries = getRealizedPnlSeries(db, "trade");
  const byWallet = getWalletPaperPerformance(db, "trade").sort((a, b) => b.totalPnl - a.totalPnl);
  const pnlTone = trade.totalPnl > 0 ? "profit" : trade.totalPnl < 0 ? "loss" : "neutral";

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🔁 Trade — copiar a los que tradean la cuota</h1>
        <p className="text-sm text-mist">
          Tercer libro, totalmente separado. Copia el <b>viaje completo</b> (compra→venta) de las billeteras
          perfiladas como <span className="text-violet-300">tradea cuota</span> con swing rentable: abre cuando ellas
          compran y <b>cierra cuando ellas venden</b>, sin esperar a la resolución. Criterios de entrada coherentes
          (puntaje, banda, deriva, spread, liquidez) como en pre-partido y en vivo. Tamaño fijo $5. Solo papel —
          nada de aquí toca los otros libros.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="PnL del libro trade" value={money(trade.totalPnl, { sign: true })} tone={pnlTone} hint={`realizado ${money(trade.realizedPnl)} · abierto ${money(trade.unrealizedPnl)}`} />
        <Stat label="Tasa de acierto" value={pct(trade.winRate)} hint={`${trade.settledCount} cerradas · ${trade.exitClosed} por venta copiada`} />
        <Stat label="Posiciones abiertas" value={String(trade.openCount)} />
        <Stat label="Reglas trade (auto)" value={trade.tradeRuleVersion ? `v${trade.tradeRuleVersion}` : "—"} hint={`${trade.quotaWallets.length} billeteras de cuota elegibles`} />
      </div>

      {trade.tradeRuleChanges.length > 0 ? (
        <Card title="Automejora del libro trade (cambios de reglas)">
          <ul className="space-y-2 text-sm">
            {trade.tradeRuleChanges.map((c) => (
              <li key={c.id}>
                <div className="text-bright">{c.reason}</div>
                <div className="text-xs text-mist">{when(c.createdAt)} · {c.beforeJson} → {c.afterJson}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="PnL del libro trade (libro paralelo)">
        <PnlChart marked={series} realized={realizedSeries} />
      </Card>

      <Card title={`Copias de cuota (${trade.trades.length})`}>
        {trade.trades.length === 0 ? (
          <Empty>
            Aún no hay copias de cuota. El libro abre cuando una billetera perfilada como «tradea cuota» con swing
            rentable compra. Se llena a medida que el perfilado (cada 12h) clasifica billeteras — sin datos falsos.
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
              {trade.trades.map((t) => {
                const pnl = t.status !== "open" ? t.realizedPnl : t.unrealizedPnl;
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

      <Card title="Rendimiento por billetera (libro trade)">
        {byWallet.length === 0 ? (
          <Empty>Aún no hay copias de cuota por billetera.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {byWallet.map((w) => (
              <li key={w.walletAddress} className="flex justify-between">
                <Link href={`/wallets/${w.walletAddress}`} className="text-accent hover:underline">
                  {shortAddr(w.walletAddress)}
                </Link>
                <span>
                  {w.tradeCount} trades · <PnlText value={w.totalPnl} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Billeteras de cuota elegibles (tradea cuota / mixto con swing rentable)">
        {trade.quotaWallets.length === 0 ? (
          <Empty>
            Todavía ninguna billetera perfilada califica como trader de cuota rentable. Aparecen aquí conforme el
            perfilado FIFO detecta compras→ventas ganadoras.
          </Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {trade.quotaWallets.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {w.tradingStyle ? <Badge value={w.tradingStyle} /> : null}
                  <Link href={`/wallets/${w.address}`} className="text-accent hover:underline">
                    {w.label ?? shortAddr(w.address)}
                  </Link>
                </span>
                <span className="text-mist">
                  swing <span className={`font-semibold ${(w.swingPnl30d ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>${(w.swingPnl30d ?? 0).toFixed(0)}</span>
                  {" · "}acierto {pct(w.swingWinRate30d)}
                  {" · "}sale antes {pct(w.earlyExitRate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="text-xs text-mist">
        Nota honesta: este libro existe para responder con datos si copiar a los traders de cuota es rentable. Si su
        PnL es consistentemente negativo, la respuesta es «no» — y eso también es un resultado valioso.
      </div>
    </div>
  );
}
