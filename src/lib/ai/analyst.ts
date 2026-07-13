import "../env";
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { aiAnalyses, decisionJournal, outcomeReviews, paperTrades, walletProfiles } from "@/db/schema";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import {
  getBenchmarkSummary,
  getInPlayPaperPerformance,
  getLiveStats,
  getOverviewStats,
  getSkipAutopsy,
  getTradeStats,
  getWalletPaperPerformance,
} from "@/lib/queries";
import {
  applyRuleChanges,
  clampRuleValue,
  getActiveRules,
  RULE_BOUNDS,
  type RuleChangeInput,
  type RuleScope,
} from "@/lib/rules";

/**
 * The AI ANALYST — an expert layer over the deterministic self-improvement.
 *
 * It reads the full picture (both ledgers, benchmark, recent settled decisions
 * with subscores) and returns: a narrative read, what it likes / dislikes, and
 * recommendations BY LEVEL. With bounded authority (option 1) it may auto-apply
 * ONLY low-level ("bajo") changes to a whitelist of rule keys, each clamped to
 * the safety bounds AND capped to a small step. Everything else is a
 * recommendation for the human. Paper only — it can never place an order; the
 * only thing it can change is a rule threshold within hard limits.
 */

// Rule keys the AI may auto-tune, with a per-run max step (defense against a
// confident-but-wrong large jump). Everything is ALSO clamped to RULE_BOUNDS.
const AI_TUNABLE: Record<string, number> = {
  maxEntryPrice: 0.03,
  minEntryPrice: 0.03,
  maxPriceDrift: 0.03,
  maxSpread: 0.02,
  minLiquidity: 500,
  minWalletGlobalScore: 5,
  minResolvedTrades: 3,
  paperCopyThreshold: 3,
  watchlistThreshold: 3,
  oneHitWonderShareThreshold: 0.05,
};

type Autonomy = "off" | "bounded" | "full";

function autonomy(): Autonomy {
  const v = (process.env.AI_AUTONOMY ?? "bounded").toLowerCase();
  return v === "off" || v === "full" ? (v as Autonomy) : "bounded";
}

export interface AiRecommendation {
  level: "bajo" | "medio" | "alto";
  scope: "core" | "live";
  title: string;
  rationale: string;
  rule_key?: string;
  proposed_value?: number;
}

export interface AiAnalysis {
  data_cutoff: string;
  summary: string;
  likes: string[];
  dislikes: string[];
  recommendations: AiRecommendation[];
  confidence: "baja" | "media" | "alta";
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    data_cutoff: { type: "string" },
    summary: { type: "string" },
    likes: { type: "array", items: { type: "string" } },
    dislikes: { type: "array", items: { type: "string" } },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          level: { type: "string", enum: ["bajo", "medio", "alto"] },
          scope: { type: "string", enum: ["core", "live"] },
          title: { type: "string" },
          rationale: { type: "string" },
          rule_key: { type: "string" },
          proposed_value: { type: "number" },
        },
        required: ["level", "scope", "title", "rationale"],
      },
    },
    confidence: { type: "string", enum: ["baja", "media", "alta"] },
  },
  required: ["data_cutoff", "summary", "likes", "dislikes", "recommendations", "confidence"],
} as const;

function gatherEvidence(db: Db) {
  const core = getOverviewStats(db);
  const bench = getBenchmarkSummary(db);
  const live = getLiveStats(db);
  const trade = getTradeStats(db);
  const ledgers = getInPlayPaperPerformance(db);
  const autopsy = getSkipAutopsy(db);
  const walletPerf = getWalletPaperPerformance(db).sort((a, b) => b.totalPnl - a.totalPnl);
  const coreRules = getActiveRules(db, "core");
  const liveRules = getActiveRules(db, "live");

  // Sample of settled CORE copies with their subscores + realized pnl, so the
  // model can spot which factors correlate with winning/losing copies.
  const settled = db
    .select()
    .from(outcomeReviews)
    .where(inArray(outcomeReviews.finalOutcome, ["won", "lost"]))
    .orderBy(desc(outcomeReviews.reviewTime))
    .limit(60)
    .all();
  const decIds = settled.map((r) => r.decisionJournalId);
  const decs = decIds.length
    ? db.select().from(decisionJournal).where(inArray(decisionJournal.id, decIds)).all()
    : [];
  const decById = new Map(decs.map((d) => [d.id, d]));
  const copySamples = settled
    .map((r) => {
      const d = decById.get(r.decisionJournalId);
      if (!d || d.decision !== "paper_copy") return null;
      return {
        pnl: Math.round((r.simulatedPnl ?? 0) * 100) / 100,
        copyScore: d.copyScore,
        walletQuality: d.walletQualityScore,
        consistency: d.consistencyScore,
        copyability: d.copyabilityScore,
        categoryFit: d.categoryFitScore,
        entryTiming: d.entryTimingScore,
        spread: d.spreadScore,
        liquidity: d.liquidityScore,
      };
    })
    .filter(Boolean)
    .slice(0, 40);

  return {
    core: {
      // totalPaperPnl = realized + unrealized (open positions marked to bid).
      // The benchmark below is REALIZED-only, so compare realizedPnl with it —
      // do not treat totalPaperPnl vs benchmark as an accounting discrepancy.
      totalPaperPnl: core.totalPaperPnl,
      realizedPnl: core.realizedPnl,
      unrealizedPnl: core.unrealizedPnl,
      winRate: core.winRate,
      resolvedCount: core.resolvedCount,
      trackedWallets: core.trackedWallets,
      benchmark: {
        botFiltered: bench.botFiltered,
        blindCopy: bench.blindCopy,
        botBeatsBlind: bench.botBeatsBlind,
        missedWinners: bench.missedWinners,
        avoidedLosers: bench.avoidedLosers,
        badCopies: bench.badCopies,
        goodSkips: bench.goodSkips,
      },
      // Skip autopsy: per-gate leak. net>0 means that filter blocked more profit
      // than loss — the concrete gate to loosen when blind copy beats the bot.
      // gate->rule key: entry_above_max=maxEntryPrice(subir), entry_below_min=
      // minEntryPrice(bajar), drift=maxPriceDrift(subir), spread=maxSpread(subir),
      // liquidity=minLiquidity(bajar), wallet_score=minWalletGlobalScore(bajar),
      // below_copy_threshold=paperCopyThreshold(bajar). Otros (is_sell, no_price,
      // resolve_*, exposure_dup) son estructurales, no un simple umbral.
      // reviewedSignals = descartes CON compuerta Y resultado (muestra usable).
      // labeledSignals = con compuerta (aunque aún sin resolver). Si labeled>0 y
      // reviewedSignals≈0, la autopsia NO está rota: las señales etiquetadas son
      // recientes (blocked_gate se añadió hace poco) y tardan 6-24h en resolver.
      // No la declares inservible por eso; se poblará con el tiempo.
      skipAutopsy: {
        gates: autopsy.gates,
        reviewedSignals: autopsy.reviewedSignals,
        labeledSignals: autopsy.labeledSignals,
      },
      rules: { version: coreRules.version, values: coreRules.rules },
    },
    live: {
      version: liveRules.version,
      rules: liveRules.rules,
      totalPnl: live.totalPnl, // realized + unrealized
      realizedPnl: live.realizedPnl,
      unrealizedPnl: live.unrealizedPnl,
      winRate: live.winRate,
      resolvedCount: live.resolvedCount,
      openCount: live.openCount,
    },
    trade: {
      version: getActiveRules(db, "trade").version,
      totalPnl: trade.totalPnl,
      winRate: trade.winRate,
      settledCount: trade.settledCount,
      exitClosed: trade.exitClosed,
      openCount: trade.openCount,
      quotaWalletCount: trade.quotaWallets.length,
    },
    ledgerComparison: ledgers,
    walletPaperPerformance: walletPerf.slice(0, 12),
    // Trading style of the tracked wallets: do they hold to resolution or
    // trade the odds (sell early)? Exits are copied in paper since v0005.
    trackedWalletStyles: db
      .select({
        address: walletProfiles.address,
        globalScore: walletProfiles.globalScore,
        tradingStyle: walletProfiles.tradingStyle,
        earlyExitRate: walletProfiles.earlyExitRate,
        swingPnl30d: walletProfiles.swingPnl30d,
        swingWinRate30d: walletProfiles.swingWinRate30d,
      })
      .from(walletProfiles)
      .where(eq(walletProfiles.status, "track"))
      .orderBy(desc(walletProfiles.globalScore))
      .limit(15)
      .all(),
    settledCopySamples: copySamples,
    // Self-review loop: the previous analysis, so the analyst can audit its own
    // past reads/recommendations against today's data and correct course.
    previousAnalysis: (() => {
      const prev = db.select().from(aiAnalyses).orderBy(desc(aiAnalyses.createdAt)).limit(1).get();
      if (!prev) return null;
      return {
        createdAt: prev.createdAt,
        summary: prev.summary,
        recommendations: prev.recommendationsJson ? JSON.parse(prev.recommendationsJson) : [],
        appliedChanges: prev.appliedChangesJson ? JSON.parse(prev.appliedChangesJson) : [],
        confidence: prev.confidence,
      };
    })(),
    ruleBounds: RULE_BOUNDS,
    tunableKeys: Object.keys(AI_TUNABLE),
  };
}

const SYSTEM_PROMPT = `Eres el analista experto de "La Sombra", un bot de investigación de copy trading en Polymarket que opera SOLO EN PAPEL (nunca dinero real). Conoces el proyecto a fondo:
- Estrategia principal (core): copia pre-partido con banda de entrada, guardia de entrada tardía, filtros de spread/liquidez, y un benchmark contra "copia ciega" del leaderboard. Si la billetera copiada VENDE su posición, el bot también cierra la copia en papel (salida copiada, status "closed").
- Perfil de estilo por billetera (trackedWalletStyles): "holdea" = sostiene hasta resolución, "tradea_cuota" = vende posiciones antes (swing sobre la cuota), "mixto" = ambas. swingPnl30d dice si ese swing les gana dinero de verdad.
- Libro trade (quota-scalper): tercer libro separado que copia el viaje completo (compra→venta) de las billeteras que tradean la cuota con swingPnl positivo. Cierra cuando la billetera vende. Tiene su propio set de reglas y se automejora aparte.
- Experimento en vivo (live): libro separado que copia apuestas in-play (con el juego en marcha), tamaño fijo, sin guardia de deriva — mide si copiar en vivo es rentable pese a la latencia.
- Ambas estrategias tienen su propio set de reglas versionado que se automejora.

CONTABILIDAD (importante para no marcar falsas discrepancias): totalPaperPnl/totalPnl = realizado + NO realizado (posiciones abiertas marcadas al bid, que se mueven). El benchmark botFiltered es SOLO realizado. Para comparar el libro contra el benchmark usa realizedPnl (no totalPaperPnl). Que totalPaperPnl y el benchmark difieran es NORMAL (uno incluye abiertas), no un error contable.

Tu trabajo: analizar el corte de datos y devolver un juicio honesto de EXPERTO. Sé directo sobre lo que te gusta y lo que NO. Distingue señal real de ruido: con pocas resueltas (<30) casi todo es varianza — dilo claramente y sé conservador.

AUTOPSIA DE DESCARTES (core.skipAutopsy): cuando la copia ciega le gana al bot, NO aflojes a ciegas. Mira la tabla por compuerta: 'net'>0 significa que ESA compuerta bloqueó más ganancia que pérdida — es la que fuga plata. Prioriza recomendar aflojar la compuerta con mayor 'net' positivo, mapeándola a su clave de regla (ver comentario en la evidencia). Si una compuerta tiene 'net'<0 está haciendo bien su trabajo (evita más pérdida que ganancia): NO la toques. Requiere muestra suficiente (reviewedSignals y 'resolved' por compuerta) antes de actuar; con poca evidencia, deja la recomendación en nivel medio para revisión humana en vez de auto-aplicar.

AUTO-REVISIÓN (obligatoria si hay previousAnalysis): antes de juzgar el corte nuevo, audita tu análisis anterior contra los datos de HOY. Empieza el summary con 1-2 frases de "revisión del corte anterior": qué lectura/recomendación tuya se sostuvo, cuál resultó equivocada o era un artefacto de datos (dilo sin excusas), y si un cambio auto-aplicado tuyo mejoró o empeoró la evidencia. No repitas recomendaciones ya resueltas; si una sigue pendiente y vigente, dilo explícitamente. Un dato en null puede ser TIMING de despliegue (pipeline recién desplegado, aún sin poblar) — antes de declarar un pipeline roto, considera si el corte anterior ya lo mostraba o si es nuevo.

Reglas para recomendaciones:
- Da recomendaciones POR NIVEL: "bajo" = ajuste pequeño y seguro respaldado por evidencia; "medio" = cambio con más impacto que conviene revisar; "alto" = cambio estructural o de criterio que requiere decisión humana.
- Solo para nivel "bajo" con evidencia sólida, puedes proponer un cambio concreto de regla (rule_key + proposed_value) que se aplicará automáticamente dentro de cotas de seguridad. Usa SOLO las claves en tunableKeys y respeta ruleBounds. Nunca propongas saltos grandes.
- Para "medio"/"alto" no hace falta rule_key: describe la recomendación para que el humano decida.
- Todo en español. No inventes datos que no estén en la evidencia.`;

function buildUserPrompt(evidence: ReturnType<typeof gatherEvidence>): string {
  return (
    "Analiza este corte de datos de La Sombra y responde en el formato JSON pedido " +
    "(data_cutoff, summary, likes, dislikes, recommendations, confidence).\n\n" +
    "EVIDENCIA:\n" +
    JSON.stringify(evidence, null, 2)
  );
}

/** Enforce whitelist + bounds + step-cap on an AI-proposed rule change. */
function safeChange(scope: RuleScope, rec: AiRecommendation, db: Db): RuleChangeInput | null {
  if (!rec.rule_key || rec.proposed_value == null) return null;
  const key = rec.rule_key;
  const maxStep = AI_TUNABLE[key];
  if (maxStep === undefined) return null; // not whitelisted
  const current = (getActiveRules(db, scope).rules as unknown as Record<string, number>)[key];
  if (typeof current !== "number") return null;
  // step-cap, then clamp to hard safety bounds
  const stepped = Math.min(current + maxStep, Math.max(current - maxStep, rec.proposed_value));
  const bounded = Math.round(clampRuleValue(key, stepped) * 10000) / 10000;
  if (bounded === current) return null;
  return {
    key,
    before: current,
    after: bounded,
    reason: `🧠 IA (${rec.level}): ${rec.title}`,
    evidence: rec.rationale.slice(0, 240),
    expectedImprovement: rec.title,
  };
}

export interface AnalystResult {
  analysis: AiAnalysis;
  applied: { scope: RuleScope; changes: RuleChangeInput[]; newVersion: number }[];
  model: string;
  tokensInput: number;
  tokensOutput: number;
  telegramText: string;
}

/** Run the analyst. Returns null (no throw) if no API key is configured. */
export async function runAiAnalyst(db: Db): Promise<AnalystResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.info("[ai-analyst] ANTHROPIC_API_KEY not set — skipping (deterministic engine still runs)");
    return null;
  }
  const model = process.env.AI_MODEL ?? "claude-opus-4-8";
  const evidence = gatherEvidence(db);
  const client = new Anthropic();

  log.info(`[ai-analyst] asking ${model} to analyze the data cutoff…`);
  const resp = await client.messages.create({
    model,
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(evidence) }],
  });

  if (resp.stop_reason === "refusal") {
    log.warn("[ai-analyst] model refused — skipping");
    return null;
  }
  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    log.warn("[ai-analyst] no text block in response — skipping");
    return null;
  }
  const analysis = JSON.parse(textBlock.text) as AiAnalysis;

  // --- apply bounded low-level changes per the autonomy setting ---
  const mode = autonomy();
  const applied: AnalystResult["applied"] = [];
  if (mode !== "off") {
    const allowLevels = mode === "full" ? new Set(["bajo", "medio"]) : new Set(["bajo"]);
    for (const scope of ["core", "live"] as RuleScope[]) {
      const changes: RuleChangeInput[] = [];
      for (const rec of analysis.recommendations) {
        if (rec.scope !== scope || !allowLevels.has(rec.level)) continue;
        const c = safeChange(scope, rec, db);
        if (c && !changes.some((x) => x.key === c.key)) changes.push(c);
      }
      if (changes.length) {
        const newVersion = applyRuleChanges(db, changes, scope, "ai-analyst");
        applied.push({ scope, changes, newVersion });
        log.info(`[ai-analyst] ${scope} rules -> v${newVersion}: ${changes.map((c) => `${c.key} ${c.before}->${c.after}`).join(", ")}`);
      }
    }
  }

  const tokensInput = resp.usage.input_tokens ?? 0;
  const tokensOutput = resp.usage.output_tokens ?? 0;

  // --- persist ---
  const appliedFlat = applied.flatMap((a) => a.changes.map((c) => ({ scope: a.scope, ...c })));
  db.insert(aiAnalyses)
    .values({
      id: newId(),
      model,
      dataCutoff: analysis.data_cutoff,
      summary: analysis.summary,
      likesJson: JSON.stringify(analysis.likes ?? []),
      dislikesJson: JSON.stringify(analysis.dislikes ?? []),
      recommendationsJson: JSON.stringify(analysis.recommendations ?? []),
      appliedChangesJson: JSON.stringify(appliedFlat),
      confidence: analysis.confidence,
      tokensInput,
      tokensOutput,
      createdAt: new Date(),
    })
    .run();

  // --- Telegram summary ---
  const recCount = analysis.recommendations.length;
  const byLevel = (lvl: string) => analysis.recommendations.filter((r) => r.level === lvl).length;
  const telegramText =
    `🧠 <b>Análisis de La Sombra</b> (${model})\n` +
    `${analysis.summary.slice(0, 350)}\n\n` +
    `Confianza: ${analysis.confidence} · Recomendaciones: ${recCount} ` +
    `(bajo ${byLevel("bajo")}, medio ${byLevel("medio")}, alto ${byLevel("alto")})\n` +
    (appliedFlat.length
      ? `Aplicado auto (acotado): ${appliedFlat.map((c) => `${c.scope}/${c.key} ${c.before}→${c.after}`).join(", ")}`
      : "Sin cambios automáticos este ciclo.") +
    `\nVer detalle en el panel → 🧠 Recomendaciones`;

  return { analysis, applied, model, tokensInput, tokensOutput, telegramText };
}
