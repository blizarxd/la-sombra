import Link from "next/link";
import { getDb } from "@/db/client";
import { getComboBookStats, getComboScanStatus, getRealizedPnlSeries } from "@/lib/queries";
import { money, pct, shortAddr, when } from "@/lib/format";
import { Card, Empty, PnlText, Stat, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";

export const dynamic = "force-dynamic";

export default function CombosPage() {
  const db = getDb();
  const combo = getComboBookStats(db);
  const scan = getComboScanStatus(db);
  const realizedSeries = getRealizedPnlSeries(db, "combo");
  const pnlTone = combo.realizedPnl > 0 ? "profit" : combo.realizedPnl < 0 ? "loss" : "neutral";

  const comboRows: TradeRowData[] = combo.trades.map((t) => ({
    id: t.id,
    openedAtMs: t.openedAt.getTime(),
    market: t.marketQuestion ?? t.marketId,
    outcome: t.outcome,
    side: t.side,
    walletAddress: t.walletAddress,
    size: t.simulatedPositionSize,
    entryPrice: t.entryPrice,
    currentPrice: t.currentPrice,
    pnl: t.status !== "open" ? t.realizedPnl : null, // open combos can't be marked (no book)
    status: t.status,
  }));

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🧩 Combos — copiar a los reyes del combo</h1>
        <p className="text-sm text-mist">
          Quinto libro, totalmente separado. Un combo (parlay) junta varias predicciones en <b>un solo pick</b>:
          paga solo si TODAS aciertan. Minamos las billeteras de la <b>Combo Cup</b> de Polymarket y copiamos en
          papel los combos de las que tienen <b>cashflow combo positivo a 30 días</b> — salir una vez en el
          leaderboard no basta (eso es pura suerte sobreviviente). Banda del precio combinado 2¢–50¢ (2x–50x),
          tamaño fijo $5, máx. 30 abiertos. Solo papel — nada de aquí toca los otros libros.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="PnL realizado (combos)"
          value={money(combo.realizedPnl, { sign: true })}
          tone={pnlTone}
          hint={`${combo.settledCount} liquidados · ${combo.cashouts} por cash-out copiado`}
        />
        <Stat label="Tasa de acierto" value={pct(combo.winRate)} hint="un combo gana solo si TODAS las patas aciertan" />
        <Stat label="Abiertos / en riesgo" value={`${combo.openCount} · ${money(combo.capitalAtRisk)}`} hint="sin libro público: no se marcan por hora" />
        <Stat
          label="Billeteras elegibles"
          value={String(combo.eligibleCount)}
          hint={`${combo.profiledCount} perfiladas de la Combo Cup · reglas v${combo.comboRuleVersion ?? "—"}`}
        />
      </div>

      <Card title="Estado del scrape del leaderboard (diagnóstico)">
        {scan === null ? (
          <p className="text-sm text-mist">
            El scraper del leaderboard aún no ha corrido en este servidor. Corre en el ciclo del operador; vuelve
            tras el próximo tick.
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {scan.ok ? (
                <span className="rounded-full border border-emerald-700 bg-emerald-950/40 px-2 py-0.5 text-xs text-profit">
                  ✅ scrape OK
                </span>
              ) : (
                <span className="rounded-full border border-rose-800 bg-rose-950/40 px-2 py-0.5 text-xs text-loss">
                  ⛔ bloqueado / 0 filas
                </span>
              )}
              <span className="text-mist">
                {when(scan.scannedAt)} · leyó <b className="text-bright">{scan.totalRows}</b> filas del board ·
                resolvió <b className="text-bright">{scan.resolved}</b> billeteras
              </span>
            </div>
            {scan.errors.length > 0 ? (
              <ul className="space-y-1 text-xs text-loss">
                {scan.errors.map((e, i) => (
                  <li key={i} className="font-mono">{e}</li>
                ))}
              </ul>
            ) : null}
            {!scan.ok ? (
              <p className="text-xs text-mist">
                0 filas casi siempre = Cloudflare está retando el frontend de polymarket.com desde la IP de este
                servidor (las APIs JSON sí responden — por eso cripto/cazador sí pueblan). El código funciona; la
                fuente es hostil a datacenters. Siguiente paso: enrutar solo este scrape por un proxy.
              </p>
            ) : null}
          </div>
        )}
      </Card>

      {combo.comboRuleChanges.length > 0 ? (
        <Card title="Automejora del libro combo (cambios de reglas)">
          <ul className="space-y-2 text-sm">
            {combo.comboRuleChanges.map((c) => (
              <li key={c.id}>
                <div className="text-bright">{c.reason}</div>
                <div className="text-xs text-mist">{when(c.createdAt)} · {c.beforeJson} → {c.afterJson}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="PnL realizado del libro combo (libro paralelo)">
        <PnlChart marked={realizedSeries} realized={realizedSeries} />
        <p className="mt-2 text-xs text-mist">
          Solo PnL realizado: los combos no tienen libro de órdenes público (se tradean por RFQ), así que un combo
          abierto no se puede marcar a mercado — vale $0 o el pago completo, nada intermedio confiable.
        </p>
      </Card>

      <Card title={`Copias de combos (${combo.trades.length})`}>
        <PaginatedTradesTable
          rows={comboRows}
          columns={["opened", "market", "wallet", "size", "entry", "pnl", "status"]}
          emptyHint="Aún no hay combos copiados. El libro abre cuando una billetera de la Combo Cup con cashflow combo positivo compra un combo dentro de la banda 2x–50x apostando ≥$10. El sourcing y el perfilado corren en el ciclo del operador — sin datos falsos."
        />
      </Card>

      <Card title="Billeteras de la Combo Cup (mejor cashflow combo 30d primero)">
        {combo.comboWallets.length === 0 ? (
          <Empty>
            Aún no hay billeteras minadas de la Combo Cup. El scraper corre en el ciclo del operador; vuelve tras
            el próximo tick.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Billetera</Th>
                  <Th className="text-right">Veces en el board</Th>
                  <Th className="text-right">Combos 30d</Th>
                  <Th className="text-right">Ganados</Th>
                  <Th className="text-right">Cashflow 30d</Th>
                  <Th className="text-right">Elegible</Th>
                </tr>
              </thead>
              <tbody>
                {combo.comboWallets.map((w) => {
                  const eligible = (w.comboNetPnl30d ?? 0) > 0 && (w.comboTradeCount30d ?? 0) >= 3 && !w.benched;
                  return (
                    <tr key={w.id} className="border-t border-edge">
                      <Td>
                        <Link href={`/wallets/${w.address}`} className="text-accent hover:underline">
                          {w.label ?? shortAddr(w.address)}
                        </Link>
                      </Td>
                      <Td className="text-right">{w.comboBoardAppearances ?? 0}</Td>
                      <Td className="text-right">{w.comboTradeCount30d ?? "—"}</Td>
                      <Td className="text-right">{w.comboRedeemCount30d ?? "—"}</Td>
                      <Td className="text-right">
                        {w.comboNetPnl30d !== null ? <PnlText value={w.comboNetPnl30d} /> : "—"}
                      </Td>
                      <Td className="text-right">{eligible ? "✅ sí" : w.comboLastProfiledAt ? "no" : "pendiente"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="space-y-1 text-xs text-mist">
        <div>
          Notas honestas: (1) La entrada se copia al precio ejecutado de la billetera — los combos van por RFQ y no
          hay libro público, así que en real podríamos no conseguir esa misma cuota. (2) Un combo GANADO se detecta
          cuando la billetera lo cobra (REDEEM, pago exacto); un cash-out se copia a su precio de venta. (3) La
          PÉRDIDA se decide <b>por las patas</b>, de dos formas. (a) Si el título deja leer el lado apostado
          («Will X win…?» = Sí) y esa pata resolvió en contra, el parlay está muerto: se anota al instante. La
          mayoría de patas son de partido («A vs B», O/U, spreads, esports) y su título <b>no dice qué lado eligió
          el apostador</b>, así que no se juzgan por ahí — inventar ese lado sería fabricar un resultado. (b) Para
          todas: cuando <b>todas</b> las patas ya resolvieron y la billetera <b>nunca cobró</b> pasada una ventana de
          12h. Esa ventana está <b>medida, no inventada</b> (16-jul, actividad pública de billeteras del Combo Cup):
          los ganadores cobran entre <b>+2,4h y +3,6h</b> tras resolverse la última pata (4 de 4), mientras que los
          combos perdidos no se cobran jamás (6 casos sin cobrar, de 22h a 304h). 12h ≈ 3,3× el cobro más lento visto.
          Sigue siendo una heurística — etiquetada — pero apoyada en una separación real entre las dos poblaciones.
          Si una pata sigue abierta, no se juzga nada: un combo con la última pata dentro de 10 días no se mata antes
          de tiempo. (4) Si
          copiar combos no es rentable, este libro lo mostrará en rojo — y eso también es un resultado. Nunca se
          envían órdenes reales.
        </div>
      </div>
    </div>
  );
}
