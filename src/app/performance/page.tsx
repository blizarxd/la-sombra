import { getDb } from "@/db/client";
import {
  getBenchmarkSummary,
  getCategoryPerformance,
  getFillRateStats,
  getPnlSeries,
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
  const bench = getBenchmarkSummary(db);
  const byWallet = getWalletPaperPerformance(db).sort((a, b) => b.totalPnl - a.totalPnl);
  const byCategory = getCategoryPerformance(db).sort((a, b) => b.totalPnl - a.totalPnl);
  const fill = getFillRateStats(db);

  const groups = [
    { name: "Bot-filtered (paper copies)", g: bench.botFiltered, star: true },
    { name: "Blind copy (every signal, $10 each)", g: bench.blindCopy },
    { name: "Watchlist only (hypothetical)", g: bench.watchlistOnly },
    { name: "Skipped (hypothetical)", g: bench.skippedOnly },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Performance</h1>
        <p className="text-sm text-mist">Paper PnL, win rates and the benchmark that matters: does filtering beat blind copying?</p>
      </header>

      <Card title="Cumulative paper PnL (hourly marks)">
        <PnlChart points={series} />
      </Card>

      <Card title="Bot-filtered vs blind leaderboard copy">
        <Table>
          <thead>
            <tr>
              <Th>Strategy</Th>
              <Th className="text-right">Signals</Th>
              <Th className="text-right">Resolved</Th>
              <Th className="text-right">Win rate</Th>
              <Th className="text-right">Avg PnL/trade</Th>
              <Th className="text-right">Total PnL</Th>
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
          Verdict:{" "}
          {bench.botBeatsBlind === null ? (
            <span className="text-mist">not enough resolved data yet</span>
          ) : bench.botBeatsBlind ? (
            <span className="font-semibold text-profit">bot filter is adding value over blind copying</span>
          ) : (
            <span className="font-semibold text-loss">blind copying is ahead — the filter is costing money</span>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Missed winners" value={String(bench.missedWinners)} tone={bench.missedWinners > 0 ? "watch" : "neutral"} hint="skipped/watchlisted signals that won" />
        <Stat label="Avoided losers" value={String(bench.avoidedLosers)} tone="profit" hint="skips that would have lost" />
        <Stat label="Bad copies" value={String(bench.badCopies)} tone={bench.badCopies > 0 ? "loss" : "neutral"} />
        <Stat label="Good skips" value={String(bench.goodSkips)} tone="profit" />
        <Stat label="Fill rate" value={pct(fill.fillRate)} hint={`${fill.unfillable} unfillable copy attempts`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Performance by wallet">
          {byWallet.length === 0 ? (
            <Empty>No paper trades yet.</Empty>
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
        <Card title="Performance by category">
          {byCategory.length === 0 ? (
            <Empty>No paper trades yet.</Empty>
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
      <div className="text-xs text-mist">Hypothetical groups assume ${10} per signal at detected price; totals are not directly comparable to sized paper trades — compare avg PnL and win rate.</div>
    </div>
  );
}
