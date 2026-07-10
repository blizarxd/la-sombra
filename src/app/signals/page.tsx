import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { decisionJournal, observedTrades } from "@/db/schema";
import { getLatestSnapshots } from "@/lib/queries";
import { hoursLeft, isDemo, money, parseJsonList, price, score, shortAddr, when } from "@/lib/format";
import { Badge, DemoTag, Empty, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

export default function SignalsPage() {
  const db = getDb();
  const signals = db.select().from(observedTrades).orderBy(desc(observedTrades.timestamp)).limit(100).all();
  const decisionRows = signals.length
    ? db
        .select()
        .from(decisionJournal)
        .where(inArray(decisionJournal.observedTradeId, signals.map((s) => s.id)))
        .all()
    : [];
  const decisionByObs = new Map(decisionRows.map((d) => [d.observedTradeId, d]));
  const snapshots = getLatestSnapshots(db, [...new Set(signals.map((s) => s.marketId))]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Trade Signals</h1>
        <p className="text-sm text-mist">New trades from tracked wallets, scored against current market conditions and the active rules.</p>
      </header>

      {signals.length === 0 ? (
        <Empty>
          No signals yet. Run <code className="text-accent">npm run monitor:trades</code> then <code className="text-accent">npm run score:trades</code>.
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Detected</Th>
              <Th>Market</Th>
              <Th>Wallet</Th>
              <Th className="text-right">Wallet entry</Th>
              <Th className="text-right">Current</Th>
              <Th className="text-right">Move</Th>
              <Th className="text-right">Spread</Th>
              <Th className="text-right">Liquidity</Th>
              <Th className="text-right">Resolves</Th>
              <Th>Decision</Th>
              <Th className="text-right">Score</Th>
              <Th>Reason / risk</Th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => {
              const d = decisionByObs.get(s.id);
              const snap = snapshots.get(s.marketId);
              const current = snap?.bestAsk ?? s.detectedPrice;
              const move = current != null ? current - s.walletEntryPrice : null;
              const reasons = d ? parseJsonList(d.reasonsJson) : [];
              const risks = d ? parseJsonList(d.risksJson) : [];
              return (
                <tr key={s.id}>
                  <Td className="whitespace-nowrap text-mist">{when(s.timestamp)}</Td>
                  <Td className="max-w-80">
                    {s.marketQuestion ?? s.marketId}
                    {isDemo(s.marketQuestion) ? <span className="ml-1"><DemoTag /></span> : null}
                    <div className="text-[11px] text-mist">{s.marketCategory ?? "—"} · {s.outcome ?? ""} · {s.side}</div>
                  </Td>
                  <Td>
                    <Link href={`/wallets/${s.walletAddress}`} className="text-accent hover:underline">
                      {shortAddr(s.walletAddress)}
                    </Link>
                  </Td>
                  <Td className="text-right">{price(s.walletEntryPrice)}</Td>
                  <Td className="text-right">{price(current)}</Td>
                  <Td className={`text-right ${move != null && Math.abs(move) > 0.05 ? "text-watch" : "text-mist"}`}>
                    {move != null ? `${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}¢` : "—"}
                  </Td>
                  <Td className="text-right text-mist">{snap?.spread != null ? snap.spread.toFixed(3) : "—"}</Td>
                  <Td className="text-right text-mist">{money(snap?.liquidity)}</Td>
                  <Td className="text-right text-mist">{hoursLeft(snap?.timeToResolution)}</Td>
                  <Td>{d ? <Badge value={d.decision} /> : <Badge value="pending" />}</Td>
                  <Td className="text-right font-semibold">{d ? score(d.copyScore) : "—"}</Td>
                  <Td className="max-w-80 text-xs">
                    {reasons.slice(0, 2).map((r, i) => (
                      <div key={i} className="text-mist">• {r}</div>
                    ))}
                    {risks.slice(0, 2).map((r, i) => (
                      <div key={i} className="text-loss">⚠ {r}</div>
                    ))}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
