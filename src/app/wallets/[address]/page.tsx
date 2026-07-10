import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { observedTrades, paperTrades, walletProfiles } from "@/db/schema";
import { isDemo, money, pct, price, score, shortAddr, when } from "@/lib/format";
import { Badge, Card, DemoTag, Empty, PnlText, Stat, Table, Td, Th } from "../../components/ui";

export const dynamic = "force-dynamic";

export default async function WalletProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const db = getDb();
  const wallet = db.select().from(walletProfiles).where(eq(walletProfiles.address, address.toLowerCase())).get()
    ?? db.select().from(walletProfiles).where(eq(walletProfiles.address, address)).get();

  if (!wallet) {
    return (
      <Empty>
        Wallet {shortAddr(address)} not found. <Link href="/wallets" className="text-accent">Back to rankings</Link>
      </Empty>
    );
  }

  const recent = db
    .select()
    .from(observedTrades)
    .where(eq(observedTrades.walletAddress, wallet.address))
    .orderBy(desc(observedTrades.timestamp))
    .limit(20)
    .all();
  const papers = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.walletAddress, wallet.address))
    .orderBy(desc(paperTrades.openedAt))
    .all();
  const paperPnl = papers.reduce((a, t) => a + (t.realizedPnl ?? t.unrealizedPnl ?? 0), 0);

  let strengths: Record<string, { trades: number; pnl: number; winRate: number }> = {};
  try {
    strengths = wallet.categoryStrengthsJson ? JSON.parse(wallet.categoryStrengthsJson) : {};
  } catch {
    /* ignore */
  }

  const copyable =
    (wallet.copyabilityScore ?? 0) >= 50
      ? { label: "COPYABLE", cls: "text-profit" }
      : { label: "HARD TO COPY", cls: "text-loss" };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{wallet.label ?? shortAddr(wallet.address)}</h1>
        <Badge value={wallet.status} />
        {isDemo(wallet.label, wallet.address) ? <DemoTag /> : null}
        <span className={`text-sm font-semibold ${copyable.cls}`}>{copyable.label}</span>
        <code className="text-xs text-mist">{wallet.address}</code>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Global score" value={score(wallet.globalScore)} />
        <Stat label="ROI 30d" value={pct(wallet.roi30d)} tone={(wallet.roi30d ?? 0) >= 0 ? "profit" : "loss"} />
        <Stat label="Win rate (resolved)" value={pct(wallet.winRate30d)} hint={`${wallet.resolvedTradeCount30d ?? 0} of ${wallet.tradeCount30d ?? 0} trades resolved`} />
        <Stat label="Avg trade size" value={money(wallet.averageTradeSize)} />
        <Stat label="1-hit-wonder penalty" value={score(wallet.oneHitWonderPenalty)} tone={(wallet.oneHitWonderPenalty ?? 0) > 30 ? "loss" : "neutral"} />
        <Stat label="Paper PnL if copied" value={money(paperPnl, { sign: true })} tone={paperPnl > 0 ? "profit" : paperPnl < 0 ? "loss" : "neutral"} hint={`${papers.length} paper trades`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Liquidity profile">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-mist">Avg market liquidity</dt><dd>{money(wallet.averageLiquidity)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Avg spread (live)</dt><dd>{wallet.averageSpread != null ? wallet.averageSpread.toFixed(3) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Avg entry drift (live)</dt><dd>{wallet.averageEntryTiming != null ? wallet.averageEntryTiming.toFixed(3) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Consistency</dt><dd>{score(wallet.consistencyScore)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Copyability</dt><dd>{score(wallet.copyabilityScore)}</dd></div>
          </dl>
        </Card>
        <Card title="Category strengths">
          {Object.keys(strengths).length === 0 ? (
            <div className="text-sm text-mist">No category data yet.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {Object.entries(strengths).map(([cat, s]) => (
                <li key={cat} className="flex justify-between">
                  <span className={cat === wallet.bestCategory ? "font-semibold text-accent" : ""}>{cat}</span>
                  <span className="text-mist">{s.trades} trades · WR {pct(s.winRate)} · <PnlText value={s.pnl} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Notes">
          <div className="space-y-2 text-sm">
            <div><span className="text-mist">Copyability: </span>{wallet.copyabilityNotes ?? "—"}</div>
            <div><span className="text-mist">Risks: </span>{wallet.riskNotes ?? "—"}</div>
            <div className="text-xs text-mist">Last scanned {when(wallet.lastScannedAt)}</div>
          </div>
        </Card>
      </div>

      <Card title={`Recent observed trades (${recent.length})`}>
        {recent.length === 0 ? (
          <div className="text-sm text-mist">No observed trades yet — the monitor picks these up while the wallet is tracked.</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th><Th>Market</Th><Th>Side</Th><Th className="text-right">Entry</Th><Th className="text-right">Detected</Th><Th className="text-right">Size</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t) => (
                <tr key={t.id}>
                  <Td className="text-mist">{when(t.timestamp)}</Td>
                  <Td className="max-w-96">{t.marketQuestion ?? t.marketId}</Td>
                  <Td><Badge value={t.side === "BUY" ? "open" : "closed"} /> {t.outcome ?? ""}</Td>
                  <Td className="text-right">{price(t.walletEntryPrice)}</Td>
                  <Td className="text-right">{price(t.detectedPrice)}</Td>
                  <Td className="text-right">{money(t.size)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
