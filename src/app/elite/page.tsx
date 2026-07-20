import { getDb } from "@/db/client";
import { getEliteBookStats, getRealizedPnlSeries } from "@/lib/queries";
import { money, pct, when } from "@/lib/format";
import { Card, Stat, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";

export const dynamic = "force-dynamic";

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

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🏆 La Crema — la matriz manda</h1>
        <p className="text-sm text-mist">
          Sexto libro, <b>reconstruido el 18-jul</b>. No tiene reglas de entrada propias: cuando Pre-partido, En Vivo,
          Cuota o Cripto YA deciden copiar una jugada, La Crema la espeja <b>solo si cae en una celda de oro de la
          matriz</b> — no importa la billetera. Celdas de oro (estrictas, sobrevivieron varios cortes):{" "}
          <b>esports barato (&lt;60¢) fuera de la noche</b>, o <b>banda 60-89¢ en la Mañana (08-11) o la Tarde (16-19)</b>. Antes seguía
          a las top-10 billeteras de cada brazo y fracasó (una billetera puede ser top-10 y aun así apostar en mala
          franja). Ahora es un experimento limpio: si La Crema se pone verde mientras los brazos sangran, la matriz
          manda de verdad. $5 fijo, libro aparte.
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
        <Stat label="Filtro" value="Celdas de oro" hint="matriz manda · esports + banda 60-89¢ mañana/tarde" />
      </div>

      <Card title="PnL realizado de la crema (libro paralelo)">
        <PnlChart marked={realizedSeries} realized={realizedSeries} />
      </Card>

      <Card title={`Copias de la crema (${elite.trades.length})`}>
        <PaginatedTradesTable
          rows={rows}
          columns={["opened", "market", "wallet", "size", "entry", "current", "pnl", "status"]}
          emptyHint="Aún no hay copias con el diseño nuevo. La crema abre cuando uno de los brazos copia un trade que cae en una celda de oro de la matriz (esports <60¢ fuera de la noche, o banda 60-89¢ en Mañana/Tarde). Se llena a medida que llegan señales frescas en esas celdas."
        />
      </Card>

      <Card title="🥇 Celdas de oro — qué espeja La Crema (y por qué)">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Celda de oro</Th>
                <Th>Evidencia de la matriz (varios cortes)</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-edge">
                <Td><b>🎮 Esports barato (&lt;60¢)</b>, cualquier hora menos la noche (20-23)</Td>
                <Td className="text-mist">Bandas bajas verdes en toda ventana (≤29¢ +26-28% · 30-44¢ +23-31%); esports CARO es rojo (60-74¢ −3,6% · 75-89¢ −10% a 7d) y quedó fuera el 20-jul tras fallar su forward-test. Rojo también de noche (−21%).</Td>
              </tr>
              <tr className="border-t border-edge">
                <Td><b>Banda 60-89¢</b> en Mañana (08-11) o Tarde (16-19)</Td>
                <Td className="text-mist">Bandas altas verdes (pre 60-74¢ +10,9%/70% · deportes 75-89¢ +10,6%/83%) en las dos franjas verdes.</Td>
              </tr>
              <tr className="border-t border-edge">
                <Td className="text-mist">Excluidas siempre: Clima, Cripto</Td>
                <Td className="text-mist">Rojas en toda la matriz (clima −38% vivo · cripto −11% cuota).</Td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="text-xs text-mist">
        Nota honesta: La Crema no filtra señales nuevas por su cuenta — espeja lo que los brazos ya deciden copiar,
        pero SOLO cuando cae en una celda de oro. Es un experimento directo sobre la tesis "la matriz manda": si este
        libro se pone verde mientras los brazos de origen sangran, concentrar en las mejores celdas SÍ suma. Si no
        supera a los brazos, la matriz por sí sola no basta — y eso también es un resultado. El histórico anterior al
        18-jul es del diseño viejo (top-10 billeteras, que fracasó: −$137, 37% acierto). Solo papel, nunca órdenes reales.
      </div>
    </div>
  );
}
