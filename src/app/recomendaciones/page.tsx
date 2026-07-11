import { getDb } from "@/db/client";
import { getAiAnalyses } from "@/lib/queries";
import { when } from "@/lib/format";
import { Card, Empty } from "../components/ui";

export const dynamic = "force-dynamic";

interface Rec {
  level: "bajo" | "medio" | "alto";
  scope: "core" | "live";
  title: string;
  rationale: string;
  rule_key?: string;
  proposed_value?: number;
}
interface AppliedChange {
  scope: string;
  key: string;
  before: number;
  after: number;
  reason: string;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const levelStyle: Record<string, string> = {
  bajo: "border-emerald-800 bg-emerald-950/40 text-profit",
  medio: "border-amber-800 bg-amber-950/40 text-watch",
  alto: "border-rose-800 bg-rose-950/40 text-loss",
};

export default function RecomendacionesPage() {
  const db = getDb();
  const analyses = getAiAnalyses(db, 20);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">🧠 Recomendaciones de La Sombra</h1>
        <p className="text-sm text-mist">
          El analista IA lee el corte de datos como experto: qué le gusta, qué no, y recomendaciones por nivel.
          Los cambios de nivel <span className="text-profit">bajo</span> se aplican solos dentro de cotas de
          seguridad; los de nivel <span className="text-watch">medio</span>/<span className="text-loss">alto</span>{" "}
          quedan como recomendación para ti. Sigue siendo solo papel.
        </p>
      </header>

      {analyses.length === 0 ? (
        <Empty>
          Aún no hay análisis de la IA. Se genera 1×/día si <code className="text-accent">ANTHROPIC_API_KEY</code>{" "}
          está configurada en Railway. El motor determinista mejora las reglas igual, gratis.
        </Empty>
      ) : (
        analyses.map((a) => {
          const likes = parse<string[]>(a.likesJson, []);
          const dislikes = parse<string[]>(a.dislikesJson, []);
          const recs = parse<Rec[]>(a.recommendationsJson, []);
          const applied = parse<AppliedChange[]>(a.appliedChangesJson, []);
          const order = { bajo: 0, medio: 1, alto: 2 } as const;
          const sorted = [...recs].sort((x, y) => (order[x.level] ?? 3) - (order[y.level] ?? 3));
          return (
            <Card key={a.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-mist">
                <span className="font-semibold text-bright">{when(a.createdAt)}</span>
                <span>· {a.model}</span>
                {a.confidence ? <span>· confianza {a.confidence}</span> : null}
                {a.dataCutoff ? <span>· {a.dataCutoff}</span> : null}
                <span className="ml-auto">{a.tokensInput}→{a.tokensOutput} tokens</span>
              </div>

              <p className="mt-2 text-sm text-bright">{a.summary}</p>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-semibold text-profit">👍 Lo que le gusta</div>
                  {likes.length ? (
                    <ul className="space-y-1 text-sm">
                      {likes.map((l, i) => (
                        <li key={i} className="text-mist">• {l}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-mist">—</span>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-xs font-semibold text-loss">👎 Lo que no le gusta</div>
                  {dislikes.length ? (
                    <ul className="space-y-1 text-sm">
                      {dislikes.map((l, i) => (
                        <li key={i} className="text-mist">• {l}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-mist">—</span>
                  )}
                </div>
              </div>

              {applied.length > 0 ? (
                <div className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/30 p-2 text-xs">
                  <span className="font-semibold text-profit">Aplicado automáticamente (acotado): </span>
                  {applied.map((c, i) => (
                    <span key={i} className="text-mist">
                      {i > 0 ? " · " : ""}{c.scope}/{c.key} {c.before}→{c.after}
                    </span>
                  ))}
                </div>
              ) : null}

              {sorted.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <div className="text-xs font-semibold text-mist">Recomendaciones por nivel</div>
                  {sorted.map((r, i) => (
                    <div key={i} className={`rounded-lg border p-2 text-sm ${levelStyle[r.level] ?? "border-edge"}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase">
                          {r.level}
                        </span>
                        <span className="text-[10px] uppercase text-mist">{r.scope}</span>
                        <span className="font-semibold text-bright">{r.title}</span>
                        {r.rule_key ? (
                          <span className="text-xs text-mist">
                            ({r.rule_key}{r.proposed_value != null ? ` → ${r.proposed_value}` : ""})
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-xs text-mist">{r.rationale}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}
