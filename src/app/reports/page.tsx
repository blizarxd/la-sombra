import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { dailyReports } from "@/db/schema";
import { isDemo, money, pct, shortAddr, when } from "@/lib/format";
import { Badge, Card, DemoTag, Empty, PnlText } from "../components/ui";

export const dynamic = "force-dynamic";

interface WalletPerf {
  walletAddress: string;
  totalPnl: number;
  tradeCount: number;
}

function parseWallets(json: string | null): WalletPerf[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default function ReportsPage() {
  const db = getDb();
  const reports = db.select().from(dailyReports).orderBy(desc(dailyReports.date)).limit(30).all();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Reportes</h1>
        <p className="text-sm text-mist">
          Reportes de cierre del día escritos por el ciclo del operador. Se envían a Telegram solo cuando TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID están configurados; siempre se guardan aquí.
        </p>
      </header>

      {reports.length === 0 ? (
        <Empty>
          Aún no hay reportes. Corre <code className="text-accent">npm run report:daily</code>.
        </Empty>
      ) : (
        <div className="space-y-4">
          {reports.map((r) => {
            const best = parseWallets(r.bestWalletsJson);
            const worst = parseWallets(r.worstWalletsJson);
            let ruleChanges: { reason: string }[] = [];
            try {
              ruleChanges = r.ruleChangesJson ? JSON.parse(r.ruleChangesJson) : [];
            } catch {
              /* ignore */
            }
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold">{r.date}</span>
                  {isDemo(r.summary) ? <DemoTag /> : null}
                  <Badge value={r.sentToTelegram ? "won" : "pending"} />
                  <span className="text-xs text-mist">{r.sentToTelegram ? "enviado a Telegram" : "solo en la BD"}</span>
                  <span className="ml-auto text-xs text-mist">generado {when(r.createdAt)}</span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
                  <div><div className="text-xs text-mist">PnL en papel (día)</div><PnlText value={r.paperPnl} /></div>
                  <div><div className="text-xs text-mist">Tasa acierto</div>{pct(r.winRate)}</div>
                  <div><div className="text-xs text-mist">Abiertas</div>{r.openPositions}</div>
                  <div><div className="text-xs text-mist">Señales</div>{r.newSignals}</div>
                  <div><div className="text-xs text-mist">Copiadas / vigiladas</div>{r.copiedSignals} / {r.watchedSignals}</div>
                  <div><div className="text-xs text-mist">Descartadas</div>{r.skippedSignals}</div>
                </div>

                <div className="mt-3 grid gap-3 text-xs md:grid-cols-3">
                  <div>
                    <div className="mb-1 font-semibold text-mist">Mejores billeteras</div>
                    {best.length ? best.map((w) => (
                      <div key={w.walletAddress}>{shortAddr(w.walletAddress)} · <PnlText value={w.totalPnl} /> ({w.tradeCount})</div>
                    )) : <span className="text-mist">—</span>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-mist">Peores billeteras</div>
                    {worst.length ? worst.map((w) => (
                      <div key={w.walletAddress}>{shortAddr(w.walletAddress)} · <PnlText value={w.totalPnl} /> ({w.tradeCount})</div>
                    )) : <span className="text-mist">—</span>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-mist">Cambios de reglas</div>
                    {ruleChanges.length ? ruleChanges.map((c, i) => <div key={i}>{c.reason}</div>) : <span className="text-mist">ninguno</span>}
                  </div>
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-accent">Texto completo del reporte</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-panel2 p-3 text-xs leading-5 text-mist">{r.summary}</pre>
                </details>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
