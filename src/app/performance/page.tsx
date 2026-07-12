import { getDb } from "@/db/client";
import {
  getBenchmarkSummary,
  getCategoryPerformance,
  getFillRateStats,
  getInPlayPaperPerformance,
  getPnlSeries,
  getRealizedPnlSeries,
  getWalletPaperPerformance,
} from "@/lib/queries";
import { money, pct, shortAddr } from "@/lib/format";
import Link from "next/link";
import { Card, Empty, PnlText, Stat, Table, Td, Th } from "../components/ui";
import { PnlChart } from "../components/PnlChart";

export const dynamic = "force-dynamic";

export default function PerformancePage() {
  const db = getDb();
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
