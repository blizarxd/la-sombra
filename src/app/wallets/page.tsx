import Link from "next/link";
import { desc, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { walletProfiles } from "@/db/schema";
import { isDemo, pct, score, shortAddr } from "@/lib/format";
import { Badge, DemoTag, Empty, Table, Td, Th } from "../components/ui";

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

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Wallet Rankings</h1>
        <p className="text-sm text-mist">
          Top-500 leaderboard scan, scored by ROI, consistency and copyability with one-hit-wonder penalty.
          {unscored > 0 ? ` ${unscored} wallets await deep profiling (npm run scan:wallets).` : ""}
        </p>
      </header>

      {scored.length === 0 ? (
        <Empty>
          No scored wallets yet. Run <code className="text-accent">npm run scan:leaderboard</code> then{" "}
          <code className="text-accent">npm run scan:wallets</code>.
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Wallet</Th>
              <Th>Status</Th>
              <Th className="text-right">Global</Th>
              <Th className="text-right">ROI 30d</Th>
              <Th className="text-right">Consistency</Th>
              <Th className="text-right">Copyability</Th>
              <Th className="text-right">1-hit penalty</Th>
              <Th>Best category</Th>
              <Th>Reason</Th>
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
