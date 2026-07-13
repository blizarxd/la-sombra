import Link from "next/link";
import { getSourcingDesk } from "@/lib/queries";
import { money, pct, price, score, shortAddr, when } from "@/lib/format";
import { Badge, Card, Empty, PnlText, Stat, Table, Td, Th } from "./ui";
import { PnlChart } from "./PnlChart";

type Desk = ReturnType<typeof getSourcingDesk>;

/**
 * Shared observation desk for market-mined wallets (/cripto, /cazador). Shows
 * the discovered wallets, their swing profile, AND the paper trades those
 * wallets generated in the books (with a PnL chart + per-wallet ranking) so the
 * section is as instrumented as the live page. Observation only — qualifying
 * wallets flow into the existing paper books, this is not a separate ledger.
 */
export function SourcingDesk({
  title,
  intro,
  desk,
  emptyHint,
  footnote,
}: {
  title: string;
  intro: string;
  desk: Desk;
  emptyHint: string;
  footnote: string;
}) {
  const pnlTone = desk.totalPnl > 0 ? "profit" : desk.totalPnl < 0 ? "loss" : "neutral";
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="text-sm text-mist">{intro}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Billeteras descubiertas" value={String(desk.total)} hint={`${desk.pendingCount} en cola por perfilar`} />
        <Stat label="Perfiladas" value={String(desk.profiledCount)} hint={`${desk.trackedCount} en seguimiento`} />
        <Stat label="Tradean cuota (elegibles)" value={String(desk.quotaCount)} />
        <Stat
          label="PnL de sus copias (papel)"
          value={money(desk.totalPnl, { sign: true })}
          tone={pnlTone}
          hint={`realizado ${money(desk.realizedPnl)} · abierto ${money(desk.unrealizedPnl)}`}
        />
      </div>

      <Card title="PnL de las copias generadas por estas billeteras (en cualquier libro)">
        {desk.tradeCount === 0 ? (
          <Empty>
            Todavía sin copias en papel de estas billeteras. Aparecerán aquí cuando una de ellas, ya perfilada y
            en seguimiento, dispare una copia en alguno de los libros (core / en vivo / trade).
          </Empty>
        ) : (
          <PnlChart marked={desk.markedSeries} realized={desk.realizedSeries} />
        )}
      </Card>

      <Card title={`Paper trades elegidos de estas billeteras (${desk.tradeCount})`}>
        {desk.trades.length === 0 ? (
          <Empty>{emptyHint}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Abierta</Th>
                <Th>Libro</Th>
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
              {desk.trades.map((t) => {
                const pnl = t.status !== "open" ? t.realizedPnl : t.unrealizedPnl;
                return (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap text-mist">{when(t.openedAt)}</Td>
                    <Td><Badge value={t.track} /></Td>
                    <Td className="max-w-72">
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
        <Card title="Ranking por billetera (PnL de sus copias)">
          {desk.byWallet.length === 0 ? (
            <Empty>Aún sin copias por billetera.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {desk.byWallet.map((w) => (
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

        <Card title={`Perfil de las billeteras descubiertas (${desk.wallets.length})`}>
          {desk.wallets.length === 0 ? (
            <Empty>{emptyHint}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Billetera</Th>
                    <Th>Estado</Th>
                    <Th>Estilo</Th>
                    <Th className="text-right">Score</Th>
                    <Th className="text-right">Ventas</Th>
                    <Th className="text-right">Swing PnL</Th>
                    <Th className="text-right">Acierto</Th>
                  </tr>
                </thead>
                <tbody>
                  {desk.wallets.map((w) => (
                    <tr key={w.id}>
                      <Td>
                        <Link href={`/wallets/${w.address}`} className="text-accent hover:underline">
                          {w.label ?? shortAddr(w.address)}
                        </Link>
                      </Td>
                      <Td><Badge value={w.status} /></Td>
                      <Td>{w.tradingStyle ? <Badge value={w.tradingStyle} /> : <span className="text-mist">—</span>}</Td>
                      <Td className="text-right">{score(w.globalScore)}</Td>
                      <Td className="text-right text-mist">{w.sellCount30d ?? 0}</Td>
                      <Td className="text-right font-semibold">
                        {w.swingPnl30d != null ? <PnlText value={w.swingPnl30d} /> : <span className="text-mist">—</span>}
                      </Td>
                      <Td className="text-right">{pct(w.swingWinRate30d)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <div className="text-xs text-mist">{footnote}</div>
    </div>
  );
}
