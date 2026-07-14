import { getDb } from "@/db/client";
import {
  getBenchmarkSummary,
  getCategoryPerformance,
  getDailyPnlByBook,
  getFillRateStats,
  getInPlayPaperPerformance,
  getPnlSeries,
  getRealizedPnlSeries,
  getResolutionWindowProjection,
  getSkipAutopsy,
  getWalletPaperPerformance,
} from "@/lib/queries";
import { dayLabel, money, pct, shortAddr } from "@/lib/format";
import Link from "next/link";
import { Card, Empty, PnlText, Stat, Table, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";

export const dynamic = "force-dynamic";

// Human-readable label + the rule lever each gate maps to (for the autopsy).
const GATE_INFO: Record<string, { label: string; lever: string }> = {
  entry_above_max: { label: "Precio sobre la banda", lever: "subir maxEntryPrice" },
  entry_below_min: { label: "Precio bajo la banda", lever: "bajar minEntryPrice" },
  drift: { label: "Entrada tardía (deriva)", lever: "subir maxPriceDrift" },
  spread: { label: "Spread ancho", lever: "subir maxSpread" },
  liquidity: { label: "Liquidez fina", lever: "bajar minLiquidity" },
  resolve_too_soon: { label: "Resuelve muy pronto", lever: "bajar minTime (estructural)" },
  resolve_too_far: { label: "Resuelve muy lejos", lever: "estructural" },
  wallet_score: { label: "Score de billetera bajo", lever: "bajar minWalletGlobalScore" },
  is_sell: { label: "Señal de venta (salida)", lever: "estructural" },
  below_copy_threshold: { label: "En banda de vigilancia", lever: "bajar paperCopyThreshold" },
  low_score: { label: "Score de copia bajo", lever: "bajar watchlistThreshold" },
  exposure_dup: { label: "Ya hay posición abierta", lever: "estructural (anti-duplicado)" },
  no_price: { label: "Sin precio en el libro", lever: "estructural" },
};

const TRACK_LABELS: Record<string, string> = {
  core: "Pre-partido",
  live: "En Vivo",
  trade: "Cuota",
  crypto: "Cripto",
  combo: "Combos",
  elite: "La Crema",
};

export default function PerformancePage() {
  const db = getDb();
  const autopsy = getSkipAutopsy(db);
  const daily = getDailyPnlByBook(db);
  const windowProj = getResolutionWindowProjection(db, "core");
  const CORE_WINDOW_DAYS = 30; // active policy cap (see enforce-core-policy)
  const series = getPnlSeries(db);
  const realizedSeries = getRealizedPnlSeries(db);
  const bench = getBenchmarkSummary(db);
  const byWallet = getWalletPaperPerformance(db).sort((a, b) => b.totalPnl - a.totalPnl);
  const byCategory = getCategoryPerformance(db).sort((a, b) => b.totalPnl - a.totalPnl);
  const fill = getFillRateStats(db);
  const inPlay = getInPlayPaperPerformance(db);

  const groups = [
    { name: "Filtrado por el bot (copias en papel)", g: bench.botFiltered, star: true },
    { name: "Copia ciega (cada señal, $10 c/u)", g: bench.blindCopy },
    { name: "Solo vigilancia (hipotético)", g: bench.watchlistOnly },
    { name: "Descartadas (hipotético)", g: bench.skippedOnly },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Rendimiento</h1>
        <p className="text-sm text-mist">PnL en papel, tasas de acierto y el benchmark que importa: ¿filtrar le gana a copiar a ciegas?</p>
      </header>

      <Card title="PnL en papel: liquidado vs valor de mercado">
        <PnlChart marked={series} realized={realizedSeries} />
      </Card>

      <Card title="Filtrado por el bot vs copia ciega del leaderboard">
        <Table>
          <thead>
            <tr>
              <Th>Estrategia</Th>
              <Th className="text-right">Señales</Th>
              <Th className="text-right">Resueltas</Th>
              <Th className="text-right">Tasa acierto</Th>
              <Th className="text-right">PnL prom./trade</Th>
              <Th className="text-right">PnL total</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ name, g, star }) => (
              <tr key={name}>
                <Td className={star ? "font-semibold text-accent" : ""}>{name}</Td>
                <Td className="text-right">{g.count}</Td>
                <Td className="text-right">{g.resolvedCount}</Td>
                <Td className="text-right">{pct(g.winRate)}</Td>
                <Td className="text-right"><PnlText value={g.avgPnl} /></Td>
                <Td className="text-right font-semibold"><PnlText value={g.totalPnl} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="mt-3 text-sm">
          Veredicto:{" "}
          {bench.botBeatsBlind === null ? (
            <span className="text-mist">aún no hay datos resueltos suficientes</span>
          ) : bench.botBeatsBlind ? (
            <span className="font-semibold text-profit">el filtro del bot aporta valor sobre copiar a ciegas</span>
          ) : (
            <span className="font-semibold text-loss">copiar a ciegas va adelante — el filtro está costando dinero</span>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Ganadoras perdidas" value={String(bench.missedWinners)} tone={bench.missedWinners > 0 ? "watch" : "neutral"} hint="señales descartadas/vigiladas que ganaron" />
        <Stat label="Perdedoras evitadas" value={String(bench.avoidedLosers)} tone="profit" hint="descartes que habrían perdido" />
        <Stat label="Malas copias" value={String(bench.badCopies)} tone={bench.badCopies > 0 ? "loss" : "neutral"} />
        <Stat label="Buenos descartes" value={String(bench.goodSkips)} tone="profit" />
        <Stat label="Tasa de llenado" value={pct(fill.fillRate)} hint={`${fill.unfillable} intentos de copia sin llenar`} />
      </div>

      <Card title="Autopsia de descartes: ¿qué compuerta fuga plata?">
        {autopsy.gates.length === 0 || autopsy.reviewedSignals === 0 ? (
          <Empty>
            Aún no hay señales descartadas <b>con compuerta etiquetada Y resultado</b>.
            {autopsy.labeledSignals > 0
              ? ` Ya hay ${autopsy.labeledSignals} señales etiquetadas esperando resolución (se etiquetan desde el despliegue del feature; tardan 6-24h en resolver). La tabla se llenará conforme resuelvan.`
              : " Se etiquetan las señales nuevas conforme el bot las descarta; la tabla se llena cuando esos mercados resuelven (vía outcome_reviews)."}
          </Empty>
        ) : (
          <>
            <div className="mb-3 text-xs text-mist">
              Para cada señal que el bot NO copió, comparamos lo que habría ganado ($10 hipotéticos hasta su
              resultado). <span className="text-loss font-semibold">Fuga neta &gt; 0</span> = esa compuerta bloqueó
              más ganancia que pérdida: candidata a aflojar. <span className="text-profit font-semibold">&lt; 0</span> =
              está haciendo bien su trabajo. Basado en {autopsy.reviewedSignals} señales con resultado.
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Compuerta</Th>
                  <Th className="text-right">Bloqueadas</Th>
                  <Th className="text-right">Con result.</Th>
                  <Th className="text-right">Ganadoras perdidas</Th>
                  <Th className="text-right">Perdedoras evitadas</Th>
                  <Th className="text-right">Fuga neta</Th>
                  <Th>Palanca</Th>
                </tr>
              </thead>
              <tbody>
                {autopsy.gates.map((g) => {
                  const info = GATE_INFO[g.gate];
                  return (
                    <tr key={g.gate}>
                      <Td className="font-medium">{info?.label ?? g.gate}</Td>
                      <Td className="text-right">{g.blocked}</Td>
                      <Td className="text-right">{g.resolved}</Td>
                      <Td className="text-right text-watch">${g.missedWinners.toFixed(2)}</Td>
                      <Td className="text-right text-profit">${g.avoidedLosers.toFixed(2)}</Td>
                      <Td className="text-right font-semibold">
                        <span className={g.net > 0 ? "text-loss" : g.net < 0 ? "text-profit" : "text-mist"}>
                          {g.net > 0 ? "+" : ""}${g.net.toFixed(2)}
                        </span>
                      </Td>
                      <Td className="text-xs text-mist">{info?.lever ?? "—"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <div className="mt-3 text-xs text-mist">
              La 🧠 IA lee esta misma tabla y prioriza aflojar la compuerta con mayor fuga neta positiva (dentro de
              cotas de seguridad), en vez de aflojar a ciegas. Ver 🧠 Recomendaciones.
            </div>
          </>
        )}
      </Card>

      <Card title="Libros en paralelo: ⚡ experimento en vivo vs estrategia principal">
        {inPlay.live.count === 0 && inPlay.preGame.count === 0 ? (
          <Empty>Aún no hay trades en papel para comparar.</Empty>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Grupo</Th>
                  <Th className="text-right">Copias</Th>
                  <Th className="text-right">Resueltas</Th>
                  <Th className="text-right">Tasa acierto</Th>
                  <Th className="text-right">PnL prom./trade</Th>
                  <Th className="text-right">PnL total</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td className="font-semibold text-orange-300">⚡ Experimento en vivo (libro aparte)</Td>
                  <Td className="text-right">{inPlay.live.count}</Td>
                  <Td className="text-right">{inPlay.live.resolvedCount}</Td>
                  <Td className="text-right">{pct(inPlay.live.winRate)}</Td>
                  <Td className="text-right"><PnlText value={inPlay.live.avgPnl} /></Td>
                  <Td className="text-right font-semibold"><PnlText value={inPlay.live.totalPnl} /></Td>
                </tr>
                <tr>
                  <Td className="font-semibold">Estrategia principal (pre-partido)</Td>
                  <Td className="text-right">{inPlay.preGame.count}</Td>
                  <Td className="text-right">{inPlay.preGame.resolvedCount}</Td>
                  <Td className="text-right">{pct(inPlay.preGame.winRate)}</Td>
                  <Td className="text-right"><PnlText value={inPlay.preGame.avgPnl} /></Td>
                  <Td className="text-right font-semibold"><PnlText value={inPlay.preGame.totalPnl} /></Td>
                </tr>
              </tbody>
            </Table>
            <div className="mt-3 text-xs text-mist">
              Libros separados que nunca se mezclan: el experimento en vivo copia in-play con $5 fijos y sin guardia
              de deriva (eso es lo que mide); la estrategia principal sigue intacta con todas sus reglas. Detalle del
              experimento en la página ⚡ En Vivo.
            </div>
          </>
        )}
      </Card>

      <Card title="Capital parado: posiciones abiertas proyectadas por ventana de resolución (core)">
        {windowProj.settledSample < 5 ? (
          <Empty>Aún no hay suficientes trades resueltos para proyectar (se necesitan ≥5).</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Abiertas ahora" value={String(windowProj.currentOpen)} />
              <Stat label="Copias/día" value={String(windowProj.arrivalPerDay)} />
              <Stat label="Hold promedio real" value={`${windowProj.impliedAvgHoldDays}d`} hint="insesgado (abiertas ÷ ritmo)" />
              <Stat label="Abiertas > 5 días" value={String(windowProj.openOlderThan5)} hint={`>14d: ${windowProj.openOlderThan14} · >30d: ${windowProj.openOlderThan30}`} />
            </div>
            <div className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-xs text-mist">
              <b className="text-bright">Lo que dicen los datos reales:</b> el core es de <b>alta rotación</b> — entran
              ~{windowProj.arrivalPerDay} copias/día y el hold promedio REAL es de solo{" "}
              <b>{windowProj.impliedAvgHoldDays} día(s)</b> (la mayoría son deportes que resuelven el mismo día). Las{" "}
              {windowProj.currentOpen} abiertas <b>no son meses de limbo</b>: solo{" "}
              <b>{windowProj.openOlderThan5}</b> llevan más de 5 días abiertas y{" "}
              <b>{windowProj.openOlderThan30}</b> más de 30. El tope de 30 días recorta esa <b>minoría</b> de largo plazo
              (el capital que de verdad se estanca), sin tocar el grueso rápido.
            </div>
            <div className="mt-3 text-xs font-semibold uppercase tracking-wider text-mist">
              Proyección por ventana (referencia — sesgada a la baja por los largos aún abiertos)
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Ventana máx.</Th>
                  <Th className="text-right">% resueltos que cerraron dentro</Th>
                  <Th className="text-right">Hold prom. (resueltos)</Th>
                  <Th className="text-right">Abiertas proyectadas*</Th>
                </tr>
              </thead>
              <tbody>
                {windowProj.projection.map((p) => {
                  const active = p.windowDays === CORE_WINDOW_DAYS;
                  return (
                    <tr key={p.windowDays} className={active ? "bg-panel2" : ""}>
                      <Td className="font-medium">
                        {p.windowDays} días{active ? <span className="ml-2 text-[11px] text-accent">← activa</span> : null}
                      </Td>
                      <Td className="text-right">{pct(p.qualifyShare)}</Td>
                      <Td className="text-right">{p.avgHoldDays}d</Td>
                      <Td className="text-right font-semibold">≈ {p.projectedOpen}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <div className="mt-3 text-xs text-mist">
              *Estimación desde trades <b>ya resueltos</b>, que están sesgados a los rápidos (los largos siguen abiertos),
              así que subestima. El número honesto para juzgar el capital parado es <b>&quot;Abiertas &gt; 30 días&quot;</b> arriba.
              Menos ventana = menos limbo largo = feedback realizado más rápido.
            </div>
          </>
        )}
      </Card>

      <Card title="PnL realizado por día y por libro (cuánto genera el sistema cada día)">
        {daily.days.length === 0 ? (
          <Empty>Aún no hay trades liquidados para desglosar por día.</Empty>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Día (UTC-4)</Th>
                  {daily.tracks.map((tr) => (
                    <Th key={tr} className="text-right">{TRACK_LABELS[tr] ?? tr}</Th>
                  ))}
                  <Th className="text-right">Total día</Th>
                </tr>
              </thead>
              <tbody>
                {daily.days.map((d) => (
                  <tr key={d.day}>
                    <Td className="whitespace-nowrap font-medium">{dayLabel(d.day)}</Td>
                    {daily.tracks.map((tr) => {
                      const c = d.byTrack[tr];
                      return (
                        <Td key={tr} className="text-right">
                          {c.count === 0 ? (
                            <span className="text-mist">—</span>
                          ) : (
                            <>
                              <PnlText value={c.pnl} />
                              <span className="ml-1 text-[10px] text-mist">({c.count})</span>
                            </>
                          )}
                        </Td>
                      );
                    })}
                    <Td className="text-right font-semibold"><PnlText value={d.total} /></Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-edge">
                  <Td className="font-semibold uppercase tracking-wider text-mist">Total</Td>
                  {daily.tracks.map((tr) => (
                    <Td key={tr} className="text-right font-semibold">
                      <PnlText value={daily.totals[tr].pnl} />
                      <span className="ml-1 text-[10px] text-mist">({daily.totals[tr].count})</span>
                    </Td>
                  ))}
                  <Td className="text-right font-bold"><PnlText value={daily.grandTotal} /></Td>
                </tr>
              </tfoot>
            </Table>
            <div className="mt-3 text-xs text-mist">
              PnL <b>realizado</b> (trades liquidados o cerrados por venta copiada) del día en que se liquidaron, en
              UTC-4. El número entre paréntesis es cuántos trades se liquidaron. Las posiciones abiertas no cuentan
              hasta que se resuelven — esto es dinero (en papel) ya generado, no valor de mercado.
            </div>
          </>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rendimiento por billetera">
          {byWallet.length === 0 ? (
            <Empty>Aún no hay trades en papel.</Empty>
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
        <Card title="Rendimiento por categoría">
          {byCategory.length === 0 ? (
            <Empty>Aún no hay trades en papel.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {byCategory.map((c) => (
                <li key={c.category} className="flex justify-between">
                  <span>{c.category}</span>
                  <span>
                    {c.tradeCount} trades · <PnlText value={c.totalPnl} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="text-xs text-mist">Los grupos hipotéticos asumen ${10} por señal al precio detectado; los totales no son directamente comparables con los trades en papel dimensionados — compara el PnL promedio y la tasa de acierto.</div>
    </div>
  );
}
