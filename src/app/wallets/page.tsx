import Link from "next/link";
import { desc, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { walletProfiles } from "@/db/schema";
import { getWalletPaperPerformance } from "@/lib/queries";
import { isDemo, pct, score, shortAddr } from "@/lib/format";
import { Badge, Card, DemoTag, Empty, PnlText, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

export default function WalletsPage() {
  const db = getDb();
  const scored = db
    .select()
    .from(walletProfiles)
    .where(isNotNull(walletProfiles.globalScore))
    .orderBy(desc(walletProfiles.globalScore))
    .limit(500)
    .all();
  const unscored = db.select({ id: walletProfiles.id }).from(walletProfiles).all().length - scored.length;
  // Per-book rankings (by paper PnL) so each ledger's best/worst wallets show here too.
  const liveRank = getWalletPaperPerformance(db, "live").sort((a, b) => b.totalPnl - a.totalPnl);
  const tradeRank = getWalletPaperPerformance(db, "trade").sort((a, b) => b.totalPnl - a.totalPnl);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Ranking de billeteras</h1>
        <p className="text-sm text-mist">
          Escaneo del top 500 del leaderboard, puntuado por ROI, consistencia y facilidad de copia, con penalización por golpe de suerte.
          {unscored > 0 ? ` ${unscored} billeteras esperan perfilado profundo (npm run scan:wallets).` : ""}
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankCard title="Ranking ⚡ En Vivo (por PnL en papel)" rows={liveRank} empty="Aún no hay copias en vivo por billetera." />
        <RankCard title="Ranking 🔁 Trade (por PnL en papel)" rows={tradeRank} empty="Aún no hay copias de cuota por billetera." />
      </div>

      {scored.length === 0 ? (
        <Empty>
          Aún no hay billeteras puntuadas. Corre <code className="text-accent">npm run scan:leaderboard</code> y luego{" "}
          <code className="text-accent">npm run scan:wallets</code>.
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Billetera</Th>
              <Th>Estado</Th>
              <Th className="text-right">Global</Th>
              <Th className="text-right">ROI 30d</Th>
              <Th className="text-right">Consistencia</Th>
              <Th className="text-right">Copiabilidad</Th>
              <Th className="text-right">Pen. suerte</Th>
              <Th>Estilo</Th>
              <Th>Mejor categoría</Th>
              <Th>Motivo</Th>
            </tr>
          </thead>
          <tbody>
            {scored.map((w, i) => (
              <tr key={w.id}>
                <Td className="text-mist">{w.sourceRank ?? i + 1}</Td>
                <Td>
                  <Link href={`/wallets/${w.address}`} className="text-accent hover:underline">
                    {w.label ?? shortAddr(w.address)}
                  </Link>
                  {isDemo(w.label, w.address) ? (
                    <span className="ml-2">
                      <DemoTag />
                    </span>
                  ) : null}
                  <div className="text-[11px] text-mist">{shortAddr(w.address)}</div>
                </Td>
                <Td>
                  <Badge value={w.status} />
                </Td>
                <Td className="text-right font-semibold">{score(w.globalScore)}</Td>
                <Td className={`text-right ${(w.roi30d ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>{pct(w.roi30d)}</Td>
                <Td className="text-right">{score(w.consistencyScore)}</Td>
                <Td className="text-right">{score(w.copyabilityScore)}</Td>
                <Td className={`text-right ${(w.oneHitWonderPenalty ?? 0) > 30 ? "text-loss" : "text-mist"}`}>
                  {score(w.oneHitWonderPenalty)}
                </Td>
                <Td>
                  {w.tradingStyle ? (
                    <>
                      <Badge value={w.tradingStyle} />
                      {w.tradingStyle !== "holdea" ? (
                        <div className="mt-0.5 text-[11px] text-mist">
                          sale antes {pct(w.earlyExitRate)} · swing{" "}
                          <span className={(w.swingPnl30d ?? 0) >= 0 ? "text-profit" : "text-loss"}>
                            ${(w.swingPnl30d ?? 0).toFixed(0)}
                          </span>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>{w.bestCategory ?? "—"}</Td>
                <Td className="max-w-72 text-xs text-mist">{w.copyabilityNotes ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function RankCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { walletAddress: string; totalPnl: number; tradeCount: number }[];
  empty: string;
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.slice(0, 10).map((w) => (
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
  );
}
