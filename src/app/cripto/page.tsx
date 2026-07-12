import Link from "next/link";
import { getDb } from "@/db/client";
import { getCryptoDesk } from "@/lib/queries";
import { money, pct, score, shortAddr } from "@/lib/format";
import { Badge, Card, Empty, PnlText, Stat, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

export default function CriptoPage() {
  const db = getDb();
  const desk = getCryptoDesk(db);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">₿ Cripto — mesa de observación</h1>
        <p className="text-sm text-mist">
          El leaderboard de ganancias solo muestra HOLDERS. Aquí minamos billeteras directamente de los
          mercados de cripto más activos (Polymarket tag «Crypto») — su naturaleza rápida y volátil es donde
          viven las billeteras que tradean cuota (compran y venden pronto). Las descubiertas se perfilan y, si
          demuestran buen swing, entran solas a los libros existentes (Trade / En Vivo). Es una mesa de
          OBSERVACIÓN, no un libro de papel aparte. Solo datos reales.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Billeteras cripto descubiertas" value={String(desk.total)} hint={`${desk.pendingCount} en cola por perfilar`} />
        <Stat label="Perfiladas" value={String(desk.profiledCount)} />
        <Stat label="En seguimiento" value={String(desk.trackedCount)} />
        <Stat label="Tradean cuota (elegibles)" value={String(desk.quotaCount)} />
      </div>

      <Card title={`Billeteras activas en mercados cripto (${desk.wallets.length})`}>
        {desk.wallets.length === 0 ? (
          <Empty>
            Aún no hay billeteras cripto perfiladas. El sourcing corre en el ciclo diario (mina los mercados
            cripto más activos); vuelve tras la próxima ronda de perfilado.
          </Empty>
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

      <div className="text-xs text-mist">
        Nota honesta: si estas billeteras resultan no tener edge de swing, la mesa lo mostrará vacía de
        elegibles — y eso también es un resultado. No inventamos actividad. Nunca se envían órdenes reales.
      </div>
    </div>
  );
}
