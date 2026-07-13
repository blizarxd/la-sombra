import Link from "next/link";
import { getDb } from "@/db/client";
import { getControlSettings } from "@/lib/control";
import { getLiveStats, getPnlSeries, getRealizedPnlSeries, getWalletPaperPerformance } from "@/lib/queries";
import { money, pct, price, score, shortAddr, when } from "@/lib/format";
import { Badge, Card, Empty, PnlText, Stat } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";
import { updateLiveControls } from "./actions";

export const dynamic = "force-dynamic";

export default function LivePage() {
  const db = getDb();
  const control = getControlSettings(db);
  const live = getLiveStats(db);
  const series = getPnlSeries(db, "live");
  const realizedSeries = getRealizedPnlSeries(db, "live");
  const byWallet = getWalletPaperPerformance(db, "live").sort((a, b) => b.totalPnl - a.totalPnl);
  const pnlTone = live.totalPnl > 0 ? "profit" : live.totalPnl < 0 ? "loss" : "neutral";

  const liveRows: TradeRowData[] = live.trades.map((t) => ({
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
        <Stat label="Reglas live (auto)" value={live.liveRuleVersion ? `v${live.liveRuleVersion}` : "—"} hint={`${live.liveSignalsToday} señales en vivo hoy`} />
      </div>

      <Card title="Control del experimento en vivo (papel)">
        <form action={updateLiveControls} className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="liveEnabled"
              defaultChecked={control.liveEnabled}
              className="h-4 w-4 accent-emerald-500"
            />
            <span>
              Copiar en vivo{" "}
              <span className={control.liveEnabled ? "text-profit" : "text-mist"}>
                ({control.liveEnabled ? "ENCENDIDO" : "APAGADO"})
              </span>
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-mist">Stake por copia (USD, papel)</span>
            <input
              type="number"
              name="liveStakeUsd"
              defaultValue={control.liveStakeUsd}
              min={1}
              max={100}
              step={0.5}
              className="w-28 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
          >
            Guardar
          </button>
        </form>
        <p className="mt-2 text-xs text-mist">
          Apagado: el libro en vivo deja de abrir copias nuevas (las abiertas siguen su curso). El premarket es
          automático y no se ve afectado. Solo papel — nunca envía órdenes reales.
        </p>
      </Card>

      {live.liveRuleChanges.length > 0 ? (
        <Card title="Automejora del experimento en vivo (cambios de reglas)">
          <ul className="space-y-2 text-sm">
            {live.liveRuleChanges.map((c) => (
              <li key={c.id}>
                <div className="text-bright">{c.reason}</div>
                <div className="text-xs text-mist">{when(c.createdAt)} · {c.beforeJson} → {c.afterJson}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="PnL del experimento en vivo (libro paralelo)">
        <PnlChart marked={series} realized={realizedSeries} />
      </Card>

      <Card title={`Copias en vivo (${live.trades.length})`}>
        <PaginatedTradesTable
          rows={liveRows}
          columns={["opened", "market", "wallet", "size", "entry", "current", "pnl", "status"]}
          emptyHint="Aún no hay copias en vivo. Se abren solas cuando una billetera seguida de calidad apuesta con el juego en marcha y el mercado pasa banda de precio, spread y liquidez."
        />
      </Card>

      <Card title="Rendimiento por billetera (libro en vivo)">
        {byWallet.length === 0 ? (
          <Empty>Aún no hay copias en vivo por billetera.</Empty>
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
