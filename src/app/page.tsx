import Link from "next/link";
import { getDb } from "@/db/client";
import { walletProfiles } from "@/db/schema";
import { desc } from "drizzle-orm";
import { getOverviewStats, getPnlSeries, getRealizedPnlSeries, getBenchmarkSummary } from "@/lib/queries";
import { money, pct, shortAddr, when, isDemo, score } from "@/lib/format";
import { Card, Stat, Badge, DemoTag, Empty, PnlText } from "./components/ui";
import { PnlChart } from "./components/PnlChart";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const db = getDb();
  const stats = getOverviewStats(db);
  const series = getPnlSeries(db);
  const realizedSeries = getRealizedPnlSeries(db);
  const bench = getBenchmarkSummary(db);
  const topWallets = db
    .select()
    .from(walletProfiles)
    .orderBy(desc(walletProfiles.globalScore))
    .limit(5)
    .all()
    .filter((w) => w.globalScore !== null);

  const pnlTone = stats.totalPaperPnl > 0 ? "profit" : stats.totalPaperPnl < 0 ? "loss" : "neutral";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">Resumen</h1>
        <p className="text-sm text-mist">¿Vamos ganando en papel? ¿Qué billeteras vale la pena copiar? ¿Qué aprendió el bot hoy?</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="PnL total en papel" value={money(stats.totalPaperPnl, { sign: true })} tone={pnlTone} hint={`realizado ${money(stats.realizedPnl)} · abierto ${money(stats.unrealizedPnl)}`} />
        <Stat label="Tasa de acierto" value={pct(stats.winRate)} hint={`${stats.resolvedCount} trades en papel resueltos`} />
        <Stat label="Posiciones abiertas" value={String(stats.openPositions.length)} />
        <Stat label="Billeteras seguidas" value={String(stats.trackedWallets)} />
        <Stat label="Candidatos a copiar hoy" value={String(stats.copyCandidatesToday)} hint={`${stats.signalsToday} señales evaluadas`} />
      </div>

      <Card title="PnL en papel a lo largo del tiempo">
        <PnlChart marked={series} realized={realizedSeries} />
        <p className="mt-2 text-xs text-mist">
          La línea <span className="text-profit">verde</span> es el PnL <b>liquidado</b> (solo trades cerrados/resueltos): el
          marcador honesto. La <span style={{ color: "#94a3b8" }}>gris</span> es el <b>valor de mercado</b> incluyendo
          posiciones abiertas marcadas al bid — se mueve en cada tick y por eso salta.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mejores billeteras por puntaje global">
          {topWallets.length === 0 ? (
            <Empty>
              Aún no hay billeteras puntuadas. Corre <code className="text-accent">npm run scan:leaderboard</code> y luego{" "}
              <code className="text-accent">npm run scan:wallets</code>.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {topWallets.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge value={w.status} />
                    <Link href={`/wallets/${w.address}`} className="text-accent hover:underline">
                      {w.label ?? shortAddr(w.address)}
                    </Link>
                    {isDemo(w.label, w.address) ? <DemoTag /> : null}
                  </span>
                  <span className="text-mist">
                    puntaje <span className="font-semibold text-bright">{score(w.globalScore)}</span> · ROI {pct(w.roi30d)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Qué aprendió el bot hoy">
          {stats.latestChanges.length === 0 ? (
            <Empty>Aún no hay cambios automáticos de reglas. El ciclo de automejora necesita resultados resueltos como evidencia.</Empty>
          ) : (
            <ul className="space-y-3 text-sm">
              {stats.latestChanges.map((c) => (
                <li key={c.id}>
                  <div className="text-bright">{c.reason}</div>
                  <div className="text-xs text-mist">
                    {when(c.createdAt)} · {c.beforeJson} → {c.afterJson}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-edge pt-3 text-xs text-mist">
            Filtrado por el bot vs copia ciega:{" "}
            {bench.botBeatsBlind === null ? (
              "aún no hay datos resueltos suficientes"
            ) : bench.botBeatsBlind ? (
              <span className="text-profit">el bot va adelante</span>
            ) : (
              <span className="text-loss">la copia ciega va adelante</span>
            )}{" "}
            (prom. bot <PnlText value={bench.botFiltered.avgPnl} /> vs prom. ciega <PnlText value={bench.blindCopy.avgPnl} /> por trade)
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Último reporte de cierre del día">
          {stats.latestReport ? (
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-semibold">{stats.latestReport.date}</span>
                <Badge value={stats.latestReport.sentToTelegram ? "won" : "pending"} />
                <span className="text-xs text-mist">{stats.latestReport.sentToTelegram ? "enviado a Telegram" : "guardado en la BD (Telegram no configurado)"}</span>
                {isDemo(stats.latestReport.summary) ? <DemoTag /> : null}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-panel2 p-3 text-xs leading-5 text-mist">
                {stats.latestReport.summary}
              </pre>
            </div>
          ) : (
            <Empty>
              Aún no hay reportes. Corre <code className="text-accent">npm run report:daily</code>.
            </Empty>
          )}
        </Card>

        <Card title="Reglas activas">
          <div className="text-sm">
            {stats.activeRuleVersion ? (
              <>
                El set de reglas <span className="font-semibold text-accent">v{stats.activeRuleVersion}</span> está activo.{" "}
                <Link href="/rules" className="text-accent hover:underline">
                  Ver umbrales e historial completo de versiones →
                </Link>
              </>
            ) : (
              <Empty>
                Reglas sin inicializar. Corre <code className="text-accent">npm run seed</code>.
              </Empty>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
