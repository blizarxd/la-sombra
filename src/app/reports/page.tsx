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
        <h1 className="text-xl font-bold">Reports</h1>
        <p className="text-sm text-mist">
          End-of-day reports written by the operator loop. Sent to Telegram only when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are configured; always stored here.
        </p>
      </header>

      {reports.length === 0 ? (
        <Empty>
          No reports yet. Run <code className="text-accent">npm run report:daily</code>.
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
                  <span className="text-xs text-mist">{r.sentToTelegram ? "sent to Telegram" : "DB only"}</span>
                  <span className="ml-auto text-xs text-mist">generated {when(r.createdAt)}</span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
                  <div><div className="text-xs text-mist">Paper PnL (day)</div><PnlText value={r.paperPnl} /></div>
                  <div><div className="text-xs text-mist">Win rate</div>{pct(r.winRate)}</div>
                  <div><div className="text-xs text-mist">Open</div>{r.openPositions}</div>
                  <div><div className="text-xs text-mist">Signals</div>{r.newSignals}</div>
                  <div><div className="text-xs text-mist">Copied / watched</div>{r.copiedSignals} / {r.watchedSignals}</div>
                  <div><div className="text-xs text-mist">Skipped</div>{r.skippedSignals}</div>
                </div>

                <div className="mt-3 grid gap-3 text-xs md:grid-cols-3">
                  <div>
                    <div className="mb-1 font-semibold text-mist">Best wallets</div>
                    {best.length ? best.map((w) => (
                      <div key={w.walletAddress}>{shortAddr(w.walletAddress)} · <PnlText value={w.totalPnl} /> ({w.tradeCount})</div>
                    )) : <span className="text-mist">—</span>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-mist">Worst wallets</div>
                    {worst.length ? worst.map((w) => (
                      <div key={w.walletAddress}>{shortAddr(w.walletAddress)} · <PnlText value={w.totalPnl} /> ({w.tradeCount})</div>
                    )) : <span className="text-mist">—</span>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-mist">Rule updates</div>
                    {ruleChanges.length ? ruleChanges.map((c, i) => <div key={i}>{c.reason}</div>) : <span className="text-mist">none</span>}
                  </div>
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-accent">Full report text</summary>
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
