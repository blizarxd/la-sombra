import { getDb } from "@/db/client";
import { getEliteBookStats, getRealizedPnlSeries } from "@/lib/queries";
import { CREMA_REBUILD_MS } from "@/lib/cremaCells";
import { money, pct, when } from "@/lib/format";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";

export const dynamic = "force-dynamic";

export default function ElitePage() {
  const db = getDb();
  const elite = getEliteBookStats(db);
  // The strategy's OWN curve: starts at the rebuild, from zero. The retired
  // design's hole is history, not this experiment's scoreboard.
  const realizedSeries = getRealizedPnlSeries(db, "elite", { openedSinceMs: CREMA_REBUILD_MS });
  const s = elite.matrixDriven;
  const pnlTone = s.totalPnl > 0 ? "profit" : s.totalPnl < 0 ? "loss" : "neutral";

  // Only the hybrid's own trades — the legacy ones are archived below.
  const rows: TradeRowData[] = elite.trades
    .filter((t) => t.goldRule)
    .map((t) => ({
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
      reason:
        t.goldRule === "mañana"
          ? "☀️ mañana 08-11"
          : t.goldRule === "esports-barato"
            ? "🎮 esports ≤29¢"
            : t.goldRule === "esports-madrugada"
              ? "🌙 esports madrugada"
              : (t.goldRule ?? undefined),
    }));

  const started = new Date(CREMA_REBUILD_MS);
  const days = Math.max(1, Math.round((Date.now() - CREMA_REBUILD_MS) / (24 * 3600 * 1000)));

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🏆 La Crema — nuestra estrategia híbrida</h1>
        <p className="text-sm text-mist">
          El sistema que seguimos: <b>solo el oro confirmado por el papel y la matriz</b>. Cuando cualquier brazo
          (Pre-partido, En Vivo, Cuota, Cripto) decide copiar una jugada, La Crema la espeja <b>solo si cae en una
          celda de oro</b> — la billetera da igual, manda la celda. Las celdas salen de un barrido completo de la matriz en 4 ventanas (todo/30d/15d/7d), quedándose solo con lo positivo en TODAS con n≥30. <b>$5 fijo</b> en todo, para que los datos sean
          comparables. Marcador desde el rediseño ({when(started)}, {days} día{days === 1 ? "" : "s"}); lo anterior es
          de un diseño retirado y está archivado abajo. Solo papel.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="PnL de la estrategia"
          value={money(s.totalPnl, { sign: true })}
          tone={pnlTone}
          hint={`realizado ${money(s.realizedPnl)} · abierto ${money(s.unrealizedPnl)}`}
        />
        <Stat label="Tasa de acierto" value={pct(s.winRate)} hint={`${s.settledCount} liquidadas`} />
        <Stat label="Posiciones abiertas" value={String(s.openCount)} hint={`${s.count} copias en total`} />
        <Stat label="Filtro de oro" value="3 celdas" hint="mañana 08-11 · esports ≤29¢ · esports madrugada" />
      </div>

      {elite.byRule.size > 0 ? (
        <Card title="🥇 Cómo va CADA celda de oro — el tablero de poda">
          <Table>
            <thead>
              <tr>
                <Th>Celda</Th>
                <Th className="text-right">Copias</Th>
                <Th className="text-right">Liquidadas</Th>
                <Th className="text-right">Acierto</Th>
                <Th className="text-right">Realizado</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {[...elite.byRule.entries()].map(([rule, r]) => (
                <tr key={rule} className="border-t border-edge">
                  <Td className="font-medium text-white">
                    {rule === "mañana"
                      ? "☀️ Mañana 08-11 (cualquier categoría)"
                      : rule === "esports-barato"
                        ? "🎮 Esports ≤29¢ (fuera de la noche)"
                        : rule === "esports-madrugada"
                          ? "🌙 Esports en Madrugada 00-03"
                          : `⚠️ ${rule} (regla retirada, ya no entra)`}
                  </Td>
                  <Td className="text-right tabular-nums">{r.count}</Td>
                  <Td className="text-right tabular-nums">{r.settledCount}</Td>
                  <Td className="text-right tabular-nums text-mist">{pct(r.winRate)}</Td>
                  <Td className="text-right">
                    <PnlText value={r.realizedPnl} />
                  </Td>
                  <Td className="text-right">
                    <PnlText value={r.totalPnl} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11px] leading-4 text-mist">
            <b>Reglas de poda y siembra, fijadas de antemano</b> para no improvisar con el resultado a la vista: se{" "}
            <b>poda</b> una celda que esté roja en 2 revisiones seguidas con n≥20 · se <b>agrega</b> una celda nueva
            solo si brilla en papel + 7 días + 1 día a la vez (3 cortes) con n≥30 · se <b>gradúa a dinero real</b> solo
            con n≥50 y ROI ≥+10% (margen para el spread y el fill que el papel no cobra).
          </p>
        </Card>
      ) : null}

      <Card title="PnL de la estrategia (desde el rediseño, desde cero)">
        <PnlChart marked={realizedSeries} realized={realizedSeries} />
      </Card>

      <Card title={`Copias de la estrategia (${rows.length})`}>
        <PaginatedTradesTable
          rows={rows}
          columns={["opened", "market", "wallet", "size", "entry", "current", "pnl", "status", "reason"]}
          emptyHint="Aún no hay copias del híbrido. Abre cuando un brazo copia un trade que cae en una celda de oro: Mañana 08-11, esports ≤29¢ fuera de la noche, o esports en Madrugada 00-03."
        />
      </Card>

      <Card title="🥇 Las celdas de oro — qué opera y con qué evidencia">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Celda</Th>
                <Th>Evidencia</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-edge">
                <Td>
                  <b>☀️ Mañana 08-11</b> — cualquier categoría
                </Td>
                <Td className="text-mist">
                  <b className="text-white">La señal más repetida de todo el sistema.</b> Verde en cada brazo a la vez:
                  Pre-partido +21,6% (n=192) · En Vivo +6,0% (n=458) · La Crema +15,1% (n=84) · esports +14,8% (n=270).
                  Y en cuatro días distintos de la semana (lun +21,9% · mié +31,6% · vie +16,0% · dom +20,7%). Ninguna
                  otra celda se repite en tantos cortes independientes.
                </Td>
              </tr>
              <tr className="border-t border-edge">
                <Td>
                  <b>🎮 Esports ≤29¢</b>, cualquier hora menos la noche (20-23)
                </Td>
                <Td className="text-mist">
                  +21,7% (n=89) en todas las ventanas, y +24,6% en los últimos 7 días. El corte quedó en 29¢ porque la
                  banda 30-44¢ <b>no</b> sobrevivió el barrido (se da vuelta en una ventana).
                </Td>
              </tr>
              <tr className="border-t border-edge">
                <Td>
                  <b>🌙 Esports en Madrugada 00-03</b> — cualquier banda
                </Td>
                <Td className="text-mist">+20,3% (n=87), positiva en las cuatro ventanas.</Td>
              </tr>
              <tr className="border-t border-edge">
                <Td className="text-mist">🚫 Podado el 20-jul: Tarde 16-19 · banda 60-89¢ suelta</Td>
                <Td className="text-mist">
                  La <b>tarde</b> no es ganadora consistente por brazo (Cuota −12,5% · En Vivo +1,9%); su única celda
                  fuerte era «tarde × jueves», un solo día de la semana = ruido. La <b>banda 60-89¢</b> suelta rinde
                  +8,1% (n=293) pero se apaga a +1,6% en 7 días, y su parte buena ya vive dentro de la mañana.
                </Td>
              </tr>
              <tr className="border-t border-edge">
                <Td className="text-mist">🚫 Excluidos siempre: Clima, Cripto, banda 45-59¢</Td>
                <Td className="text-mist">
                  Clima y cripto sangran en todo brazo y toda ventana. La banda 45-59¢ «moneda al aire» pierde en papel
                  y en dinero real (esports 3/7 −19,6% · deportes 3/6 −13,2%).
                </Td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="📦 Archivo — diseño retirado (top-10 billeteras)">
        <div className="flex flex-wrap gap-6 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wider text-mist">PnL</div>
            <PnlText value={elite.legacy.totalPnl} />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-mist">Acierto</div>
            <div>{pct(elite.legacy.winRate)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-mist">Liquidadas</div>
            <div>{elite.legacy.settledCount}</div>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-mist">
          Hasta el 18-jul La Crema copiaba a las top-10 billeteras semanales de cada brazo. Fracasó: una billetera puede
          ser top-10 y aun así apostar en una franja mala, así que el roster arrastraba las celdas malas del brazo. Se
          conserva el histórico porque el resultado negativo también es un dato — pero <b>no cuenta para el marcador de
          la estrategia actual</b>, que empieza de cero el 18-jul.
        </p>
      </Card>

      <div className="text-xs text-mist">
        Nota honesta: el híbrido no busca señales por su cuenta — espeja lo que los brazos ya deciden copiar, pero solo
        en celdas de oro. Es la prueba directa de la tesis «la matriz manda»: si se pone verde mientras los brazos de
        origen sangran, concentrar en las mejores celdas suma de verdad. Limitación conocida: si ningún brazo copia una
        señal, el híbrido nunca la ve — y hoy no cubre la veta 30-44¢ del brazo Cuota. Solo papel, nunca órdenes reales.
      </div>
    </div>
  );
}
