import { getDb } from "@/db/client";
import { getCremaCellsOverview, getEliteBookStats, getRealizedPnlSeries } from "@/lib/queries";
import { CREMA_REBUILD_MS, goldRuleLabel } from "@/lib/cremaCells";
import type { CellRow } from "@/lib/goldEngine";
import { EXPLORE_BUDGET, HITS_TO_ACTIVATE, MAX_ACTIVE_GOLD, MIN_CELL_N, MISSES_TO_RETIRE } from "@/lib/goldEngine";
import { money, pct, when } from "@/lib/format";
import { Card, PnlText, Stat, Table, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";
import { PaginatedTradesTable, type TradeRowData } from "../components/PaginatedTradesTable";

export const dynamic = "force-dynamic";

function EvidenceCells({ cell }: { cell: CellRow }) {
  const w = cell.windows;
  if (!w?.all) return <span className="text-mist">evidencia pendiente del próximo escaneo</span>;
  const fmt = (k: string) => {
    const s = w[k];
    if (!s) return null;
    return `${k}: ${(s.roi * 100).toFixed(1)}% (n=${s.n})`;
  };
  return (
    <span className="tabular-nums">
      {["all", "30d", "15d", "7d"].map(fmt).filter(Boolean).join(" · ")}
    </span>
  );
}

export default function ElitePage() {
  const db = getDb();
  const elite = getEliteBookStats(db);
  const cellsOverview = getCremaCellsOverview(db);
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
      reason: t.goldRule ? goldRuleLabel(t.goldRule) : undefined,
    }));

  const started = new Date(CREMA_REBUILD_MS);
  const days = Math.max(1, Math.round((Date.now() - CREMA_REBUILD_MS) / (24 * 3600 * 1000)));
  const goldCount = cellsOverview.activeGold.length;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🏆 La Crema — nuestra estrategia híbrida (auto-evolutiva)</h1>
        <p className="text-sm text-mist">
          El sistema que seguimos: <b>solo el oro confirmado por el papel y la matriz</b>. Cuando cualquier brazo
          (Pre-partido, En Vivo, Cuota, Cripto) decide copiar una jugada, La Crema la espeja <b>solo si cae en una
          celda de oro activa</b> — la billetera da igual, manda la celda. Desde el 20-jul el filtro es{" "}
          <b>auto-evolutivo</b>: cada corte diario el Buscador de Oro re-escanea TODAS las celdas de la matriz en 4
          ventanas (todo/30d/15d/7d, estándar: positiva en todas con n≥{MIN_CELL_N}); una celda entra tras{" "}
          {HITS_TO_ACTIVATE} escaneos seguidos como sobreviviente y se poda tras {MISSES_TO_RETIRE} escaneos fallando —
          nadie improvisa con el resultado a la vista. <b>$5 fijo</b> en todo. Marcador desde el rediseño (
          {when(started)}, {days} día{days === 1 ? "" : "s"}); lo anterior es de un diseño retirado, archivado abajo.
          Solo papel.
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
        <Stat
          label="Filtro de oro"
          value={`${goldCount} celda${goldCount === 1 ? "" : "s"}`}
          hint={`+ ${cellsOverview.activeTraps.length} veto${cellsOverview.activeTraps.length === 1 ? "" : "s"} · ${cellsOverview.candidatas.length} en observación`}
        />
      </div>

      <Card title="🥇 Celdas de oro ACTIVAS — lo que el híbrido opera hoy">
        {cellsOverview.activeGold.length === 0 ? (
          <p className="text-sm text-mist">
            Aún no hay celdas en la base — el próximo corte diario siembra el set del 20-jul y arranca el escaneo.
            Mientras tanto el híbrido opera con las semillas (mañana 08-11 · esports ≤29¢ · esports madrugada).
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Celda</Th>
                <Th>Evidencia (ROI por ventana)</Th>
                <Th className="text-right">Activa desde</Th>
              </tr>
            </thead>
            <tbody>
              {cellsOverview.activeGold.map((c) => (
                <tr key={c.id} className="border-t border-edge">
                  <Td className="font-medium text-white">{c.label}</Td>
                  <Td className="text-mist">
                    <EvidenceCells cell={c} />
                  </Td>
                  <Td className="text-right text-mist">{c.activatedAt ? when(new Date(c.activatedAt)) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {cellsOverview.activeTraps.length > 0 ? (
          <p className="mt-2 text-[11px] leading-4 text-mist">
            🚫 <b>Vetos activos</b> (celdas trampa — rojas en toda ventana; una jugada que caiga aquí NO entra aunque
            otra celda la invite):{" "}
            {cellsOverview.activeTraps.map((c) => c.label).join(" · ")}. Excluidos permanentes: 🌦️ Clima y ₿ Cripto.
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-4 text-mist">Excluidos permanentes: 🌦️ Clima y ₿ Cripto.</p>
        )}
        {cellsOverview.candidatas.length > 0 ? (
          <p className="mt-1 text-[11px] leading-4 text-mist">
            👀 <b>En observación</b> ({cellsOverview.candidatas.length}): sobrevivieron 1 escaneo, necesitan{" "}
            {HITS_TO_ACTIVATE} seguidos para activarse —{" "}
            {cellsOverview.candidatas
              .slice(0, 6)
              .map((c) => `${c.kind === "trap" ? "🚫 " : ""}${c.label}`)
              .join(" · ")}
            {cellsOverview.candidatas.length > 6 ? " …" : ""}
          </p>
        ) : null}
      </Card>

      <Card title="👻 El Libro Sombra — sospechas de oro donde nunca apostamos">
        <p className="text-[11px] leading-4 text-mist">
          Cada señal que <b>descartamos</b> se sigue hasta su resultado, así que sabemos qué habría pagado. Son ~100
          veces más datos que nuestras propias copias, y son la única forma de encontrar una veta en la que el bot nunca
          entró: antes solo podía descubrir oro donde ya estaba apostando, y por eso se confirmaba a sí mismo.
          <br />
          <b className="text-white">Estas celdas NO operan.</b> Un contrafactual no paga spread ni sufre deslizamiento,
          así que es optimista por construcción: solo puede <i>nominar</i>. La confirmación la compra el presupuesto de
          exploración con llenado real.
        </p>
        {cellsOverview.sospechas.length === 0 ? (
          <p className="mt-2 text-sm text-mist">
            Todavía no hay sospechas — hacen falta señales descartadas ya resueltas. El primer corte con datos frescos
            las empieza a levantar.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Celda sospechosa</Th>
                <Th>Evidencia contrafactual</Th>
                <Th className="text-right">Copias reales</Th>
              </tr>
            </thead>
            <tbody>
              {cellsOverview.sospechas.map((c) => (
                <tr key={c.id} className="border-t border-edge">
                  <Td className="font-medium text-white">{c.label}</Td>
                  <Td className="text-mist">
                    <EvidenceCells cell={c} />
                  </Td>
                  <Td className="text-right text-mist">{c.realN > 0 ? c.realN : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-[11px] leading-4 text-mist">
          🎲 <b>Exploración</b>: el {Math.round(EXPLORE_BUDGET * 100)}% de las copias se reserva para la celda{" "}
          <i>menos conocida</i> (la que menos llenado real tiene), no para la de mejor ROI — ahí es donde una copia
          compra más información. Llevamos <b className="text-white">{cellsOverview.exploration.n}</b> copias de
          exploración
          {cellsOverview.exploration.roi !== null
            ? ` · ROI ${(cellsOverview.exploration.roi * 100).toFixed(1)}%`
            : ""}
          . Van en cuenta aparte: el precio de aprender no se mezcla con el resultado de la estrategia.
        </p>
      </Card>

      {elite.byRule.size > 0 ? (
        <Card title="⚖️ Cómo va CADA celda — el tablero de poda">
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
                  <Td className="font-medium text-white">{goldRuleLabel(rule)}</Td>
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
            <b>Reglas del ciclo, fijadas de antemano y ahora AUTOMÁTICAS</b>: el Buscador de Oro re-escanea cada corte
            diario · una celda <b>entra</b> tras {HITS_TO_ACTIVATE} escaneos seguidos sobreviviendo el estándar
            (positiva en TODAS las ventanas con n≥{MIN_CELL_N}, ROI ≥ +5%) · se <b>poda</b> tras {MISSES_TO_RETIRE}{" "}
            escaneos seguidos fallándolo · cupo máximo {MAX_ACTIVE_GOLD} celdas para que nunca «todo sea oro» · se{" "}
            <b>gradúa a dinero real</b> solo con n≥50 y ROI ≥+10% en SU fila de este tablero (margen para el spread y
            el fill que el papel no cobra).
          </p>
        </Card>
      ) : null}

      {cellsOverview.events.length > 0 ? (
        <Card title="🧬 Diario de evolución — qué aprendió y cuándo">
          <ul className="space-y-1 text-sm">
            {cellsOverview.events.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="shrink-0 text-mist tabular-nums">{when(e.at)}</span>
                <span
                  className={
                    e.action === "podada" || e.action === "descartada"
                      ? "shrink-0 font-medium text-rose-400"
                      : e.action === "activada" || e.action === "reactivada" || e.action === "semilla"
                        ? "shrink-0 font-medium text-emerald-400"
                        : "shrink-0 font-medium text-amber-300"
                  }
                >
                  {e.action}
                </span>
                <span className="text-mist">{e.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="PnL de la estrategia (desde el rediseño, desde cero)">
        <PnlChart marked={realizedSeries} realized={realizedSeries} />
      </Card>

      <Card title={`Copias de la estrategia (${rows.length})`}>
        <PaginatedTradesTable
          rows={rows}
          columns={["opened", "market", "wallet", "size", "entry", "current", "pnl", "status", "reason"]}
          emptyHint="Aún no hay copias del híbrido. Abre cuando un brazo copia un trade que cae en una celda de oro activa."
        />
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
        en celdas de oro activas. Es la prueba directa de la tesis «la matriz manda»: si se pone verde mientras los
        brazos de origen sangran, concentrar en las mejores celdas suma de verdad. El Buscador de Oro se alimenta SOLO
        de los brazos fuente (nunca de las copias del propio híbrido, para no auto-confirmarse; nunca de Combo, cuya
        economía de parlay ensuciaría el ROI por celda). Las celdas por día de la semana quedan fuera a propósito: con
        ~2 semanas de datos, «mañana × miércoles» es un miércoles con suerte, no una ley. Solo papel, nunca órdenes
        reales.
      </div>
    </div>
  );
}
