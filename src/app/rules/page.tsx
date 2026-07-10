import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ruleChanges, ruleSets } from "@/db/schema";
import type { Rules } from "@/lib/rules";
import { when } from "@/lib/format";
import { Badge, Card, Empty, Table, Td, Th } from "../components/ui";

export const dynamic = "force-dynamic";

const thresholdLabels: [keyof Rules, string, string][] = [
  ["maxEntryPrice", "Max entry price", "skip paper BUYs above this ask (entry-band discipline)"],
  ["minEntryPrice", "Min entry price", "skip lottery-ticket entries below this"],
  ["maxPriceDrift", "Max price drift", "late-entry guard: skip if price moved more since wallet entry"],
  ["maxSpread", "Max spread", "skip books wider than this"],
  ["minLiquidity", "Min liquidity ($)", "skip markets thinner than this"],
  ["minTimeToResolutionHours", "Min time to resolution (h)", "avoid last-minute entries"],
  ["maxTimeToResolutionHours", "Max time to resolution (h)", "avoid capital parked for months"],
  ["minWalletGlobalScore", "Min wallet score", "only copy wallets above this global score"],
  ["minResolvedTrades", "Min resolved trades", "wallet history requirement"],
  ["oneHitWonderShareThreshold", "One-hit-wonder share", "top-trade profit share that triggers the penalty"],
  ["paperCopyThreshold", "Paper-copy threshold", "copy score needed to open a paper trade"],
  ["watchlistThreshold", "Watchlist threshold", "copy score needed to watchlist"],
  ["minPositionSize", "Min position ($)", "simulated size floor"],
  ["maxPositionSize", "Max position ($)", "simulated size cap"],
];

export default function RulesPage() {
  const db = getDb();
  const active = db.select().from(ruleSets).where(eq(ruleSets.active, true)).get();
  const versions = db.select().from(ruleSets).orderBy(desc(ruleSets.version)).all();
  const changes = db.select().from(ruleChanges).orderBy(desc(ruleChanges.createdAt)).all();
  const rules: Rules | null = active ? JSON.parse(active.rulesJson) : null;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Rules</h1>
        <p className="text-sm text-mist">
          The self-improvement loop tunes these automatically (paper only, bounded steps) — every change is versioned with reason, evidence, before and after.
        </p>
      </header>

      {!rules || !active ? (
        <Empty>
          Rules not initialized. Run <code className="text-accent">npm run seed</code>.
        </Empty>
      ) : (
        <>
          <Card title={`Active thresholds — rule set v${active.version} (since ${when(active.createdAt)})`}>
            <Table>
              <thead>
                <tr>
                  <Th>Rule</Th>
                  <Th className="text-right">Value</Th>
                  <Th>What it does</Th>
                </tr>
              </thead>
              <tbody>
                {thresholdLabels.map(([key, label, help]) => (
                  <tr key={key}>
                    <Td className="font-medium">{label}</Td>
                    <Td className="text-right font-semibold text-accent">{String(rules[key])}</Td>
                    <Td className="text-xs text-mist">{help}</Td>
                  </tr>
                ))}
                <tr>
                  <Td className="font-medium">Trade score weights</Td>
                  <Td className="text-right" />
                  <Td className="text-xs text-mist">
                    {Object.entries(rules.tradeWeights).map(([k, v]) => `${k} ${v}`).join(" · ")}
                  </Td>
                </tr>
                <tr>
                  <Td className="font-medium">Wallet score weights</Td>
                  <Td className="text-right" />
                  <Td className="text-xs text-mist">
                    {Object.entries(rules.walletWeights).map(([k, v]) => `${k} ${v}`).join(" · ")}
                  </Td>
                </tr>
              </tbody>
            </Table>
          </Card>

          <Card title={`Automatic changes (${changes.length})`}>
            {changes.length === 0 ? (
              <div className="text-sm text-mist">
                No automatic changes yet. update:rules changes thresholds only when there are at least 5-10 resolved outcomes as evidence.
              </div>
            ) : (
              <div className="space-y-3">
                {changes.map((c) => (
                  <div key={c.id} className="rounded-lg bg-panel2 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge value="resolved" />
                      <span className="font-semibold">{c.reason}</span>
                      <span className="ml-auto text-xs text-mist">{when(c.createdAt)} · by {c.changedBy}</span>
                    </div>
                    <div className="mt-1 text-xs text-mist">Evidence: {c.evidenceSummary}</div>
                    <div className="mt-1 text-xs">
                      <span className="text-loss">before {c.beforeJson}</span>{" "}
                      <span className="text-profit">after {c.afterJson}</span>
                    </div>
                    {c.expectedImprovement ? (
                      <div className="mt-1 text-xs text-mist">Expected: {c.expectedImprovement}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Version history">
            <ul className="space-y-1 text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className={v.active ? "font-semibold text-accent" : "text-mist"}>v{v.version}</span>
                  {v.active ? <Badge value="track" /> : null}
                  <span className="text-xs text-mist">created {when(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
