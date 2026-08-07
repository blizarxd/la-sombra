import "../env";
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { aiAnalyses, decisionJournal, outcomeReviews, paperTrades, walletProfiles } from "@/db/schema";
import { newId } from "@/lib/ids";
import { log } from "@/lib/logger";
import {
  getBenchmarkSummary,
  getComboBookStats,
  getComboScanStatus,
  getCryptoBookStats,
  getCremaCellsOverview,
  getEliteBookStats,
  getInPlayPaperPerformance,
  getLiveStats,
  getOverviewStats,
  getSkipAutopsy,
  getSliceMatrices,
  getTradeStats,
  getWalletPaperPerformance,
} from "@/lib/queries";
import { researchSummary } from "@/lib/research";
import { summarizeMatrices } from "@/lib/slices";
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
//
// EXCLUDED ON PURPOSE (2026-07-14 incident): this used to also include
// maxEntryPrice, minEntryPrice, maxPriceDrift, maxSpread, minLiquidity and
// minWalletGlobalScore/paperCopyThreshold. The auto-apply loop below runs for
// BOTH "core" and "live" scope, and BOTH scopes have their own deterministic
// tuner (update-rules.ts / update-rules-live.ts) that independently touches
// several of those same keys every daily cycle, right before this analyst
// runs. The two layers fought over core's maxEntryPrice — the AI raised it
// one cut, the deterministic tuner lowered it again next cut — and the AI's
// own self-review flagged the "revert" as a possible bug when it was really
// an ownership collision. Fix: every lever below is verified to have ZERO
// deterministic tuner touching it in EITHER core or live scope, so there is
// exactly one tuner per key. The AI still SEES and can RECOMMEND (medio/alto)
// changes on the excluded keys for any book (including trade/crypto, whose
// own deterministic tuners already own them) — it just never auto-applies.
const AI_TUNABLE: Record<string, number> = {
  minResolvedTrades: 3,
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
  // Auto-apply only ever fires for "core"/"live" (see the loop below) — trade,
  // crypto, combo and elite are valid tags so the AI can opine and recommend
  // on every book, but those recommendations are always human-reviewed.
  scope: "core" | "live" | "trade" | "crypto" | "combo" | "elite";
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
          scope: { type: "string", enum: ["core", "live", "trade", "crypto", "combo", "elite"] },
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
  const crypto = getCryptoBookStats(db);
  const combo = getComboBookStats(db);
  const comboScan = getComboScanStatus(db);
  const elite = getEliteBookStats(db);
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
    crypto: {
      version: crypto.cryptoRuleVersion,
      realizedPnl: crypto.realizedPnl,
      unrealizedPnl: crypto.unrealizedPnl,
      winRate: crypto.winRate,
      settledCount: crypto.settledCount,
      openCount: crypto.openCount,
    },
    combo: {
      realizedPnl: combo.realizedPnl,
      winRate: combo.winRate,
      settledCount: combo.settledCount,
      openCount: combo.openCount,
      capitalAtRisk: combo.capitalAtRisk,
      eligibleWallets: combo.eligibleCount,
      // Scrape health: if this shows blocked, don't recommend combo band
      // tweaks — the bottleneck is the leaderboard scrape, not the rules.
      leaderboardScrapeOk: comboScan?.ok ?? null,
    },
    elite: (() => {
      // No rules of its own — it mirrors an arm's ALREADY-approved copy only
      // when it lands in an active gold cell. `rosterSize`/`lastRefreshedAt`
      // used to live here and were fed for weeks after the roster was retired
      // (2026-07-18); the analyst reasonably read rosterSize=0 as a broken job
      // and spent its top-priority slot on a phantom bug two cuts running. The
      // cure is to show the state that actually drives the book.
      const cells = getCremaCellsOverview(db);
      const brief = (c: { id: string; label: string; realN: number; windows: Record<string, { roi: number; n: number; strictLcb: number | null }> | null }) => ({
        celda: c.label,
        id: c.id,
        copiasReales: c.realN,
        roi: c.windows?.all ? `${(c.windows.all.roi * 100).toFixed(1)}%` : null,
        piso: c.windows?.all?.strictLcb == null ? null : `${(c.windows.all.strictLcb * 100).toFixed(1)}%`,
        n: c.windows?.all?.n ?? null,
      });
      return {
        totalPnl: elite.totalPnl,
        realizedPnl: elite.realizedPnl,
        winRate: elite.winRate,
        settledCount: elite.settledCount,
        openCount: elite.openCount,
        rosterRetiradoNota:
          "El roster top-10 se retiró el 2026-07-18 tras fracasar. La Crema es dirigida por celdas de oro. No hay nada que arreglar aquí.",
        celdasOroActivas: cells.activeGold.map(brief),
        celdasTrampaActivas: cells.activeTraps.map(brief),
        candidatas: cells.candidatas.length,
        sospechasDelLibroSombra: cells.sospechas.map(brief),
        exploracion: cells.exploration,
      };
    })(),
    ledgerComparison: ledgers,
    // The slice matrices (hour block / entry band / weekday, per book). Only
    // cells with enough sample are included. These are HYPOTHESES, never rules:
    // see the "Matrices" section of the system prompt.
    sliceMatrices: summarizeMatrices(getSliceMatrices(db)),
    // 🔬 Three costs/signals the bot stored but never measured: what copying
    // gives away at entry, how often independent wallets agree, and whether any
    // exit rule beats holding. Same status as the matrices: HYPOTHESES to argue
    // with, never rules — and each carries its own stated bias.
    research: researchSummary(db),
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
- Libro trade (quota-scalper): tercer libro separado que copia el viaje completo (compra→venta) de las billeteras que tradean la cuota con swingPnl positivo. Cierra cuando la billetera vende. Tiene su propio set de reglas y se automejora aparte (update-rules-trade.ts, corregido 2026-07-14 tras detectar que afinaba una palanca desconectada del gate real).
- Experimento en vivo (live): libro separado que copia apuestas in-play (con el juego en marcha), tamaño fijo, sin guardia de deriva — mide si copiar en vivo es rentable pese a la latencia.
- ₿ Libro cripto: cuarto libro, copia BUYs de billeteras minadas de mercados cripto (BTC/ETH Up-or-Down, ~15min) dentro de una banda de precio calculada 55–75¢. Elegibilidad: holder probado O trader de cuota probado (fix 2026-07-14 — antes solo holder-score, que rechazaba casi todos los scalpers rápidos). Se automejora aparte (update-rules-crypto.ts, nuevo 2026-07-14).
- 🧩 Libro combo: quinto libro, copia combos (parlays, tratados como un solo pick) de billeteras del leaderboard "Combo Cup" con cashflow combo positivo a 30 días. Sin libro de órdenes público (RFQ) — la pérdida se detecta por heurística de 7 días sin cobro. leaderboardScrapeOk en la evidencia dice si el scraper del leaderboard está funcionando en este servidor; si es false, el libro no puede poblarse aunque las reglas estén bien — no recomiendes tocar la banda de precio en ese caso.
- 🏆 Libro elite ("la crema"): sexto libro, SIN reglas de entrada propias. IMPORTANTE — el diseño de top-10 billeteras se RETIRÓ el 2026-07-18 tras fracasar (-134, 26% aciertos): el roster ya no existe y \`rosterSize=0\` es el estado correcto, NO un fallo. No recomiendes arreglarlo. Desde entonces La Crema es dirigida por CELDAS DE ORO de la matriz (cremaCells en la evidencia): cuando un brazo YA copia una jugada, elite la espeja solo si cae en una celda de oro ACTIVA y ninguna celda TRAMPA la veta. Las celdas se re-derivan cada corte con histéresis pre-registrada (2 escaneos seguidos sobreviviendo para activarse, 2 fallando para podarse) y se ordenan por su PISO corregido, no por ROI. Hay además un nivel "sospecha": celdas nominadas por el libro sombra (contrafactuales de señales que descartamos) que NUNCA operan solas — solo las alcanza el presupuesto de exploración (12% de las copias, dirigido a la celda MENOS conocida) para comprarles llenado real. Las copias exploratorias se contabilizan aparte: son el precio de aprender, no rendimiento de la estrategia.
- Todas las estrategias con reglas propias tienen su set versionado que se automejora por separado.

CONTABILIDAD (importante para no marcar falsas discrepancias): totalPaperPnl/totalPnl = realizado + NO realizado (posiciones abiertas marcadas al bid, que se mueven). El benchmark botFiltered es SOLO realizado. Para comparar el libro contra el benchmark usa realizedPnl (no totalPaperPnl). Que totalPaperPnl y el benchmark difieran es NORMAL (uno incluye abiertas), no un error contable.

Tu trabajo: analizar el corte de datos y devolver un juicio honesto de EXPERTO. Sé directo sobre lo que te gusta y lo que NO. Distingue señal real de ruido: con pocas resueltas (<30) casi todo es varianza — dilo claramente y sé conservador.

AUTOPSIA DE DESCARTES (core.skipAutopsy): cuando la copia ciega le gana al bot, NO aflojes a ciegas. Mira la tabla por compuerta: 'net'>0 significa que ESA compuerta bloqueó más ganancia que pérdida — es la que fuga plata. Prioriza recomendar aflojar la compuerta con mayor 'net' positivo, mapeándola a su clave de regla (ver comentario en la evidencia). Si una compuerta tiene 'net'<0 está haciendo bien su trabajo (evita más pérdida que ganancia): NO la toques. Requiere muestra suficiente (reviewedSignals y 'resolved' por compuerta) antes de actuar; con poca evidencia, deja la recomendación en nivel medio para revisión humana en vez de auto-aplicar.

AUTO-REVISIÓN (obligatoria si hay previousAnalysis): antes de juzgar el corte nuevo, audita tu análisis anterior contra los datos de HOY. Empieza el summary con 1-2 frases de "revisión del corte anterior": qué lectura/recomendación tuya se sostuvo, cuál resultó equivocada o era un artefacto de datos (dilo sin excusas), y si un cambio auto-aplicado tuyo mejoró o empeoró la evidencia. No repitas recomendaciones ya resueltas; si una sigue pendiente y vigente, dilo explícitamente. Un dato en null puede ser TIMING de despliegue (pipeline recién desplegado, aún sin poblar) — antes de declarar un pipeline roto, considera si el corte anterior ya lo mostraba o si es nuevo.

Reglas para recomendaciones:
- Opina de LOS 6 LIBROS cuando haya evidencia (core, live, trade, crypto, combo, elite) — no te limites a core/live. Usa el campo scope para etiquetar cada recomendación con el libro correcto.
- Da recomendaciones POR NIVEL: "bajo" = ajuste pequeño y seguro respaldado por evidencia; "medio" = cambio con más impacto que conviene revisar; "alto" = cambio estructural o de criterio que requiere decisión humana.
- AUTO-APLICAR (rule_key + proposed_value) SOLO es posible en nivel "bajo" Y scope "core" o "live" Y usando una clave en tunableKeys — cualquier otra combinación (incluida trade/crypto/combo, o core/live con una clave fuera de tunableKeys) queda como recomendación para el humano, aunque la marques "bajo". Esto es a propósito: trade y crypto ya tienen su propio afinador determinista dueño de esas palancas (evita la colisión que pasó el 2026-07-14 con maxEntryPrice en core). Respeta ruleBounds. Nunca propongas saltos grandes.
- elite no tiene rule_key posible (no tiene reglas propias) — tus recomendaciones sobre elite son sobre la POLÍTICA DE CELDAS (el estándar de supervivencia, el cupo de celdas activas, el tamaño del presupuesto de exploración, qué brazos alimentan el escaneo) o sobre si el experimento está funcionando, nunca un ajuste de regla. NUNCA recomiendes arreglar el roster: está retirado a propósito desde el 2026-07-18.
- Para "medio"/"alto" no hace falta rule_key: describe la recomendación para que el humano decida.
- Todo en español. No inventes datos que no estén en la evidencia.

Matrices (sliceMatrices) — franja horaria, banda de entrada y día de la semana, por libro:
- Son HIPÓTESIS, no reglas. Estos son los MISMOS trades cortados de varias formas: con decenas de celdas, alguna se ve fantástica por puro azar. Nunca recomiendes nivel "bajo" (auto-aplicable) basándote SOLO en una celda de la matriz.
- Solo te pasamos las celdas que superan el mínimo de muestra; aun así, una celda con n=6 no es evidencia fuerte. Pondera por ROI y por n, no por PnL bruto (los libros apuestan tamaños distintos).
- Si ves un patrón que se repite en VARIOS libros a la vez (p.ej. la misma banda de entrada rinde en core y en live), eso sí es señal: propónlo como recomendación "medio" y pide forward-test antes de convertirlo en regla.
- Si un patrón aparece en un solo libro y en una sola celda, dilo como observación a vigilar, con nivel "medio" como máximo y diciendo explícitamente que puede ser ruido.
- Cada celda trae ahora un "piso" (cota inferior corregida por cuántas celdas compitieron). El ROI es lo que la celda HIZO; el piso es lo que vale la pena APOSTAR. Un ROI alto con piso negativo es una hipótesis, no un hallazgo: dilo así. Cuando dos celdas compitan, prefiere SIEMPRE la de piso más alto aunque su ROI sea menor.
- Mira también ROI/día, no solo ROI: un +8% que resuelve en 4h rota seis veces al día y le gana a un +20% que tarda cinco días. Si una veta buena es lenta, dilo.

Investigación (research) — tres cosas que el bot guardaba y nunca medía:
- drag: lo que ENTREGAMOS en la entrada por llenar peor que la billetera que copiamos. Si "roiCedido" de un grupo supera a su "roiRealizado", esa celda no tiene ventaja: tiene un peaje invisible. Es el primer sitio donde mirar cuando una veta rinde menos de lo que la matriz promete.
- confluencia: billeteras DISTINTAS coincidiendo en el mismo resultado. Es la única señal aquí que no depende de confiar en una billetera concreta. Si hay racimos suficientes, propón medirla como filtro (nivel "medio", con forward-test) — todavía no es una regla.
- salidas: qué habría pasado con reglas de salida sobre el camino de precios YA registrado. Trae dos sesgos declarados (marcas horarias ⇒ es un PISO; salida a precio medio ⇒ optimista en ~1 spread). Nunca recomiendes una política de salida a nivel "bajo": ninguna de estas cifras pagó spread de verdad.`;

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
