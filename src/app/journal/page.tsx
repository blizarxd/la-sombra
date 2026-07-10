import Link from "next/link";
import { desc, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { decisionJournal, observedTrades, outcomeReviews } from "@/db/schema";
import { isDemo, parseJsonList, score, shortAddr, when } from "@/lib/format";
import { Badge, Card, DemoTag, Empty, PnlText } from "../components/ui";

export const dynamic = "force-dynamic";

const subscoreKeys = [
  ["walletQualityScore", "wallet"],
  ["roiScore", "roi"],
  ["consistencyScore", "consist"],
  ["copyabilityScore", "copyable"],
  ["categoryFitScore", "category"],
  ["entryTimingScore", "timing"],
  ["spreadScore", "spread"],
  ["liquidityScore", "liquidity"],
  ["thesisScore", "thesis"],
] as const;

export default function JournalPage() {
  const db = getDb();
  const decisions = db.select().from(decisionJournal).orderBy(desc(decisionJournal.createdAt)).limit(60).all();
  const reviews = decisions.length
    ? db
        .select()
        .from(outcomeReviews)
        .where(inArray(outcomeReviews.decisionJournalId, decisions.map((d) => d.id)))
        .all()
    : [];
  const reviewByDecision = new Map(reviews.map((r) => [r.decisionJournalId, r]));
  const observed = decisions.length
    ? db
        .select()
        .from(observedTrades)
        .where(inArray(observedTrades.id, decisions.map((d) => d.observedTradeId)))
        .all()
    : [];
  const obsById = new Map(observed.map((o) => [o.id, o]));

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Decision Journal</h1>
        <p className="text-sm text-mist">Every decision with its score breakdown, reasons, risks — and the verdict once the outcome is known.</p>
      </header>

      {decisions.length === 0 ? (
        <Empty>No decisions yet. Run the loop: monitor:trades → score:trades.</Empty>
      ) : (
        <div className="space-y-3">
          {decisions.map((d) => {
            const r = reviewByDecision.get(d.id);
            const obs = obsById.get(d.observedTradeId);
            const reasons = parseJsonList(d.reasonsJson);
            const risks = parseJsonList(d.risksJson);
            const lessons = r ? parseJsonList(r.lessonsJson) : [];
            return (
              <Card key={d.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge value={d.decision} />
                  <span className="text-sm font-semibold">score {score(d.copyScore)}</span>
                  <span className="text-xs text-mist">conf {(d.confidence * 100).toFixed(0)}%</span>
                  <span className="max-w-96 truncate text-sm">{obs?.marketQuestion ?? d.marketId}</span>
                  {isDemo(obs?.marketQuestion) ? <DemoTag /> : null}
                  <Link href={`/wallets/${d.walletAddress}`} className="text-xs text-accent hover:underline">
                    {shortAddr(d.walletAddress)}
                  </Link>
                  <span className="ml-auto text-xs text-mist">{when(d.createdAt)} · rules v{d.ruleSetVersion ?? "?"}</span>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {subscoreKeys.map(([key, label]) => {
                    const v = d[key];
                    const cls = v == null ? "text-mist" : v >= 70 ? "text-profit" : v >= 45 ? "text-watch" : "text-loss";
                    return (
                      <span key={key} className="rounded-md bg-panel2 px-2 py-1 text-[11px]">
                        <span className="text-mist">{label} </span>
                        <span className={`font-semibold ${cls}`}>{score(v)}</span>
                      </span>
                    );
                  })}
                </div>

                <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                  <div>
                    <div className="mb-1 font-semibold text-mist">Reasons</div>
                    {reasons.length ? reasons.map((x, i) => <div key={i} className="text-bright">• {x}</div>) : <span className="text-mist">—</span>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-mist">Risks</div>
                    {risks.length ? risks.map((x, i) => <div key={i} className="text-loss">⚠ {x}</div>) : <span className="text-mist">—</span>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-mist">Verdict & lesson</div>
                    {r && r.finalOutcome && r.finalOutcome !== "pending" ? (
                      <div>
                        <Badge value={r.finalOutcome} />{" "}
                        <span className={r.wasDecisionGood ? "text-profit" : "text-loss"}>
                          {r.wasDecisionGood ? "good decision" : "bad decision"}
                        </span>{" "}
                        · <PnlText value={r.simulatedPnl} />
                        {lessons.map((l, i) => (
                          <div key={i} className="mt-1 text-mist">{l}</div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-mist">pending review</span>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
