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
        Billetera {shortAddr(address)} no encontrada. <Link href="/wallets" className="text-accent">Volver al ranking</Link>
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
      ? { label: "COPIABLE", cls: "text-profit" }
      : { label: "DIFÍCIL DE COPIAR", cls: "text-loss" };

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
        <Stat label="Puntaje global" value={score(wallet.globalScore)} />
        <Stat label="ROI 30d" value={pct(wallet.roi30d)} tone={(wallet.roi30d ?? 0) >= 0 ? "profit" : "loss"} />
        <Stat label="Tasa de acierto (resuelto)" value={pct(wallet.winRate30d)} hint={`${wallet.resolvedTradeCount30d ?? 0} de ${wallet.tradeCount30d ?? 0} trades resueltos`} />
        <Stat label="Tamaño prom. de trade" value={money(wallet.averageTradeSize)} />
        <Stat label="Penal. golpe de suerte" value={score(wallet.oneHitWonderPenalty)} tone={(wallet.oneHitWonderPenalty ?? 0) > 30 ? "loss" : "neutral"} />
        <Stat label="PnL en papel si se copia" value={money(paperPnl, { sign: true })} tone={paperPnl > 0 ? "profit" : paperPnl < 0 ? "loss" : "neutral"} hint={`${papers.length} trades en papel`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Perfil de liquidez">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-mist">Liquidez prom. del mercado</dt><dd>{money(wallet.averageLiquidity)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Spread prom. (en vivo)</dt><dd>{wallet.averageSpread != null ? wallet.averageSpread.toFixed(3) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Deriva prom. de entrada (en vivo)</dt><dd>{wallet.averageEntryTiming != null ? wallet.averageEntryTiming.toFixed(3) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Consistencia</dt><dd>{score(wallet.consistencyScore)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Copiabilidad</dt><dd>{score(wallet.copyabilityScore)}</dd></div>
          </dl>
        </Card>
        <Card title="Fortalezas por categoría">
          {Object.keys(strengths).length === 0 ? (
            <div className="text-sm text-mist">Aún no hay datos de categoría.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {Object.entries(strengths).map(([cat, s]) => (
                <li key={cat} className="flex justify-between">
                  <span className={cat === wallet.bestCategory ? "font-semibold text-accent" : ""}>{cat}</span>
                  <span className="text-mist">{s.trades} trades · TA {pct(s.winRate)} · <PnlText value={s.pnl} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Notas">
          <div className="space-y-2 text-sm">
            <div><span className="text-mist">Copiabilidad: </span>{wallet.copyabilityNotes ?? "—"}</div>
            <div><span className="text-mist">Riesgos: </span>{wallet.riskNotes ?? "—"}</div>
            <div className="text-xs text-mist">Último escaneo {when(wallet.lastScannedAt)}</div>
          </div>
        </Card>
      </div>

      <Card title={`Trades observados recientes (${recent.length})`}>
        {recent.length === 0 ? (
          <div className="text-sm text-mist">Aún no hay trades observados — el monitor los capta mientras la billetera está seguida.</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Hora</Th><Th>Mercado</Th><Th>Lado</Th><Th className="text-right">Entrada</Th><Th className="text-right">Detectado</Th><Th className="text-right">Tamaño</Th>
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
