import Link from "next/link";
import { getDb } from "@/db/client";
import { walletProfiles } from "@/db/schema";
import { desc } from "drizzle-orm";
import { getOverviewStats, getPnlSeries, getBenchmarkSummary } from "@/lib/queries";
import { money, pct, shortAddr, when, isDemo, score } from "@/lib/format";
import { Card, Stat, Badge, DemoTag, Empty, PnlText } from "./components/ui";
import { PnlChart } from "./components/PnlChart";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const db = getDb();
  const stats = getOverviewStats(db);
  const series = getPnlSeries(db);
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
        <h1 className="text-xl font-bold">Overview</h1>
        <p className="text-sm text-mist">Are we profitable on paper? Which wallets are worth copying? What did the bot learn today?</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Total paper PnL" value={money(stats.totalPaperPnl, { sign: true })} tone={pnlTone} hint={`realized ${money(stats.realizedPnl)} · open ${money(stats.unrealizedPnl)}`} />
        <Stat label="Win rate" value={pct(stats.winRate)} hint={`${stats.resolvedCount} resolved paper trades`} />
        <Stat label="Open positions" value={String(stats.openPositions.length)} />
        <Stat label="Tracked wallets" value={String(stats.trackedWallets)} />
        <Stat label="Copy candidates today" value={String(stats.copyCandidatesToday)} hint={`${stats.signalsToday} signals scored`} />
      </div>

      <Card title="Paper PnL over time">
        <PnlChart points={series} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top wallets by global score">
          {topWallets.length === 0 ? (
            <Empty>
              No scored wallets yet. Run <code className="text-accent">npm run scan:leaderboard</code> then{" "}
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
                    score <span className="font-semibold text-bright">{score(w.globalScore)}</span> · ROI {pct(w.roi30d)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="What the bot learned today">
          {stats.latestChanges.length === 0 ? (
            <Empty>No automatic rule changes yet. The self-improvement loop needs resolved outcomes as evidence.</Empty>
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
            Bot-filtered vs blind copy:{" "}
            {bench.botBeatsBlind === null ? (
              "not enough resolved data yet"
            ) : bench.botBeatsBlind ? (
              <span className="text-profit">bot ahead</span>
            ) : (
              <span className="text-loss">blind ahead</span>
            )}{" "}
            (bot avg <PnlText value={bench.botFiltered.avgPnl} /> vs blind avg <PnlText value={bench.blindCopy.avgPnl} /> per trade)
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Latest EOD report">
          {stats.latestReport ? (
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="font-semibold">{stats.latestReport.date}</span>
                <Badge value={stats.latestReport.sentToTelegram ? "won" : "pending"} />
                <span className="text-xs text-mist">{stats.latestReport.sentToTelegram ? "sent to Telegram" : "stored in DB (Telegram not configured)"}</span>
                {isDemo(stats.latestReport.summary) ? <DemoTag /> : null}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-panel2 p-3 text-xs leading-5 text-mist">
                {stats.latestReport.summary}
              </pre>
            </div>
          ) : (
            <Empty>
              No reports yet. Run <code className="text-accent">npm run report:daily</code>.
            </Empty>
          )}
        </Card>

        <Card title="Active rules">
          <div className="text-sm">
            {stats.activeRuleVersion ? (
              <>
                Rule set <span className="font-semibold text-accent">v{stats.activeRuleVersion}</span> is active.{" "}
                <Link href="/rules" className="text-accent hover:underline">
                  View thresholds and full version history →
                </Link>
              </>
            ) : (
              <Empty>
                Rules not initialized. Run <code className="text-accent">npm run seed</code>.
              </Empty>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
