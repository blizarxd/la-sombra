import Link from "next/link";
import { getDb } from "@/db/client";
import {
  getCryptoBookStats,
  getPnlSeries,
  getRealizedPnlSeries,
  getSourcingDesk,
  getWalletPaperPerformance,
} from "@/lib/queries";
import { money, pct, price, shortAddr, when } from "@/lib/format";
import { Card, Empty, PnlText, Stat } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";
import { SourcingDesk } from "../components/SourcingDesk";

export const dynamic = "force-dynamic";

export default function CriptoPage() {
  const db = getDb();
  const crypto = getCryptoBookStats(db);
  const series = getPnlSeries(db, "crypto");
  const realizedSeries = getRealizedPnlSeries(db, "crypto");
  const byWallet = getWalletPaperPerformance(db, "crypto").sort((a, b) => b.totalPnl - a.totalPnl);
  const desk = getSourcingDesk(db, "crypto-market");
  const pnlTone = crypto.totalPnl > 0 ? "profit" : crypto.totalPnl < 0 ? "loss" : "neutral";

  const cryptoRows: TradeRowData[] = crypto.trades.map((t) => ({
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
        <h1 className="text-xl font-bold">₿ Cripto — libro dedicado</h1>
        <p className="text-sm text-mist">
          Cuarto libro, totalmente separado. Copia en papel las <b>compras</b> de billeteras minadas de los mercados
          de cripto (tag «Crypto») dentro de una <b>banda de entrada 55–75¢</b> — arriba del volado (~50¢, sin edge) y
          debajo del favorito caro (&gt;80¢, mal payoff). Tamaño fijo $5, cierra cuando la billetera vende. Tiene sus
          propias reglas que se automejoran. Solo papel — nada de aquí toca los otros libros.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="PnL del libro cripto" value={money(crypto.totalPnl, { sign: true })} tone={pnlTone} hint={`realizado ${money(crypto.realizedPnl)} · abierto ${money(crypto.unrealizedPnl)}`} />
        <Stat label="Tasa de acierto" value={pct(crypto.winRate)} hint={`${crypto.settledCount} cerradas · ${crypto.exitClosed} por venta copiada`} />
        <Stat label="Posiciones abiertas" value={String(crypto.openCount)} />
        <Stat label="Reglas cripto (auto)" value={crypto.cryptoRuleVersion ? `v${crypto.cryptoRuleVersion}` : "—"} hint="banda 55–75¢ · $5 fijo" />
      </div>

      {crypto.cryptoRuleChanges.length > 0 ? (
        <Card title="Automejora del libro cripto (cambios de reglas)">
          <ul className="space-y-2 text-sm">
            {crypto.cryptoRuleChanges.map((c) => (
              <li key={c.id}>
                <div className="text-bright">{c.reason}</div>
                <div className="text-xs text-mist">{when(c.createdAt)} · {c.beforeJson} → {c.afterJson}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="PnL del libro cripto (libro paralelo)">
        <PnlChart marked={series} realized={realizedSeries} />
      </Card>

      <Card title={`Copias cripto (${crypto.trades.length})`}>
        <PaginatedTradesTable
          rows={cryptoRows}
          columns={["opened", "market", "wallet", "size", "entry", "current", "pnl", "status"]}
          emptyHint="Aún no hay copias cripto. El libro abre cuando una billetera minada de cripto compra dentro de la banda 55–75¢. Se llena a medida que el sourcing + perfilado clasifican billeteras — sin datos falsos."
        />
      </Card>

      <Card title="Rendimiento por billetera (libro cripto)">
        {byWallet.length === 0 ? (
          <Empty>Aún no hay copias cripto por billetera.</Empty>
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

      <div className="border-t border-edge pt-4 text-xs uppercase tracking-wider text-mist">
        Mesa de observación — de dónde salen estas billeteras
      </div>
      <SourcingDesk
        title="₿ Mesa de observación cripto"
        intro="El leaderboard de ganancias solo muestra HOLDERS. Aquí minamos billeteras directamente de los mercados de cripto más activos (Polymarket tag «Crypto»). Las descubiertas se perfilan y, si compran dentro de la banda, alimentan el libro cripto de arriba. Solo datos reales."
        desk={desk}
        emptyHint="Aún no hay billeteras cripto perfiladas. El sourcing corre en el ciclo del operador (mina los mercados cripto más activos); vuelve tras la próxima ronda de perfilado."
        footnote="Nota honesta: si estas billeteras resultan no tener edge, el libro cripto lo mostrará en rojo — y eso también es un resultado. No inventamos actividad. Nunca se envían órdenes reales."
      />
    </div>
  );
}
