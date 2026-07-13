import Link from "next/link";
import { getSourcingDesk } from "@/lib/queries";
import { pct, score, shortAddr } from "@/lib/format";
import { Badge, Card, Empty, PnlText, Stat, Table, Td, Th } from "./ui";

type Desk = ReturnType<typeof getSourcingDesk>;

/**
 * Shared observation desk for market-mined wallets (/cripto, /cazador). Shows
 * the discovered wallets and their swing profile. Observation only — qualifying
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
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="text-sm text-mist">{intro}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Billeteras descubiertas" value={String(desk.total)} hint={`${desk.pendingCount} en cola por perfilar`} />
        <Stat label="Perfiladas" value={String(desk.profiledCount)} />
        <Stat label="En seguimiento" value={String(desk.trackedCount)} />
        <Stat label="Tradean cuota (elegibles)" value={String(desk.quotaCount)} />
      </div>

      <Card title={`Billeteras activas (${desk.wallets.length})`}>
        {desk.wallets.length === 0 ? (
          <Empty>{emptyHint}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Billetera</Th>
                <Th>Estado</Th>
                <Th>Estilo</Th>
                <Th className="text-right">Score</Th>
                <Th className="text-right">Ventas 30d</Th>
                <Th className="text-right">Swing PnL</Th>
                <Th className="text-right">Acierto swing</Th>
                <Th>Mejor categoría</Th>
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
                  <Td>
                    <Badge value={w.status} />
                  </Td>
                  <Td>{w.tradingStyle ? <Badge value={w.tradingStyle} /> : <span className="text-mist">—</span>}</Td>
                  <Td className="text-right">{score(w.globalScore)}</Td>
                  <Td className="text-right text-mist">{w.sellCount30d ?? 0}</Td>
                  <Td className="text-right font-semibold">
                    {w.swingPnl30d != null ? <PnlText value={w.swingPnl30d} /> : <span className="text-mist">—</span>}
                  </Td>
                  <Td className="text-right">{pct(w.swingWinRate30d)}</Td>
                  <Td className="text-mist">{w.bestCategory ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="text-xs text-mist">{footnote}</div>
    </div>
  );
}
