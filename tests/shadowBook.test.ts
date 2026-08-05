import { describe, expect, it } from "vitest";
import {
  EXPLORE_BUDGET,
  MIN_SHADOW_N,
  MISSES_TO_RETIRE,
  applyScan,
  cellLabel,
  parseCellId,
  scanCells,
  verdictFromCells,
  type CellRow,
  type ScanTrade,
} from "@/lib/goldEngine";
import { SHADOW_STAKE, toShadowTrades, type ShadowRow } from "@/lib/shadowBook";

/**
 * The counterfactual stream and the exploration budget are one mechanism in two
 * halves: shadow evidence NOMINATES a cell, exploration goes and buys real fills
 * for it, real fills confirm or kill it. These tests pin the seam between them —
 * above all, that shadow evidence can never by itself make the hybrid copy.
 */

const NOW = Date.UTC(2026, 7, 4, 16, 0, 0);
const MORNING_UTC = 13; // 09:00 Caracas
const DAY = 24 * 3600 * 1000;

function shadowRow(o: Partial<ShadowRow> = {}): ShadowRow {
  return {
    decision: "skip",
    simulatedPnl: 3,
    finalOutcome: "won",
    marketQuestion: "LoL: G2 vs T1 bo3",
    entryPrice: 0.25,
    decidedAt: NOW - DAY,
    ...o,
  };
}

function realTrade(o: { daysAgo: number; utcHour: number; pnl: number; question?: string; price?: number }): ScanTrade {
  const base = new Date(NOW - o.daysAgo * DAY);
  base.setUTCHours(o.utcHour, 30, 0, 0);
  return {
    track: "core",
    entryPrice: o.price ?? 0.65,
    simulatedPositionSize: 5,
    realizedPnl: o.pnl,
    openedAt: base,
    marketQuestion: o.question ?? "Team A vs. Team B",
    resolvedAt: new Date(base.getTime() + 3 * 3600 * 1000),
  };
}

/** n counterfactuals of a cell, `winEvery`-th one a loser. */
function shadowCell(n: number, winEvery: number, o: Partial<ShadowRow> = {}): ShadowRow[] {
  return Array.from({ length: n }, (_, i) =>
    shadowRow({ ...o, simulatedPnl: i % winEvery === 0 ? -10 : 6, decidedAt: NOW - (i % 20) * DAY }),
  );
}

describe("toShadowTrades", () => {
  it("convierte una señal descartada y resuelta en evidencia escaneable", () => {
    const [t] = toShadowTrades([shadowRow()]);
    expect(t.track).toBe("shadow");
    expect(t.simulatedPositionSize).toBe(SHADOW_STAKE);
    expect(t.realizedPnl).toBe(3);
  });

  it("NO se atribuye a ningún brazo — no sabemos qué libro la habría tomado", () => {
    const [t] = toShadowTrades([shadowRow()]);
    expect(["core", "live", "trade", "crypto"]).not.toContain(t.track);
  });

  it("no inventa duración: un trade que nunca ocurrió no tiene fecha de cierre", () => {
    const [t] = toShadowTrades([shadowRow()]);
    expect(t.resolvedAt).toBeNull();
    expect(t.closedAt).toBeNull();
  });

  it("ignora las copias reales — esas ya viven en el libro de verdad", () => {
    expect(toShadowTrades([shadowRow({ decision: "paper_copy" })])).toHaveLength(0);
  });

  it("ignora lo que aún no resolvió", () => {
    expect(toShadowTrades([shadowRow({ finalOutcome: "pending" })])).toHaveLength(0);
    expect(toShadowTrades([shadowRow({ simulatedPnl: null })])).toHaveLength(0);
  });

  it("ignora precios imposibles en vez de meter basura a la matriz", () => {
    expect(toShadowTrades([shadowRow({ entryPrice: 0 })])).toHaveLength(0);
    expect(toShadowTrades([shadowRow({ entryPrice: 1 })])).toHaveLength(0);
    expect(toShadowTrades([shadowRow({ entryPrice: null })])).toHaveLength(0);
  });

  it("acepta la lista vacía sin quejarse", () => {
    expect(toShadowTrades([])).toEqual([]);
  });
});

describe("scanCells — la corriente sombra", () => {
  it("sin corriente sombra no hay sospechas: el comportamiento viejo intacto", () => {
    const real = Array.from({ length: 40 }, (_, i) =>
      realTrade({ daysAgo: i % 10, utcHour: MORNING_UTC, pnl: i % 4 === 0 ? -2 : 2 }),
    );
    expect(scanCells(real, NOW).suspects).toEqual([]);
  });

  it("una celda solo vista en señales descartadas sale como SOSPECHA", () => {
    const shadow = toShadowTrades(shadowCell(MIN_SHADOW_N + 40, 4));
    const { gold, suspects } = scanCells([], NOW, shadow);
    expect(gold).toEqual([]);
    expect(suspects.length).toBeGreaterThan(0);
    expect(suspects.every((s) => s.source === "shadow")).toBe(true);
  });

  it("le exige MUCHA más muestra que a la evidencia real — es gratis de acumular", () => {
    const thin = toShadowTrades(shadowCell(MIN_SHADOW_N - 20, 4));
    expect(scanCells([], NOW, thin).suspects).toEqual([]);
  });

  it("la evidencia REAL manda: una celda ya juzgada no vuelve como sospecha", () => {
    const real = Array.from({ length: 40 }, (_, i) =>
      realTrade({ daysAgo: i % 10, utcHour: MORNING_UTC, pnl: i % 4 === 0 ? -2 : 2 }),
    );
    const shadow = toShadowTrades(
      shadowCell(MIN_SHADOW_N + 40, 4, { marketQuestion: "Team A vs. Team B", entryPrice: 0.65 }),
    );
    const { gold, suspects } = scanCells(real, NOW, shadow);
    const goldIds = new Set(gold.map((g) => g.id));
    expect(goldIds.has("hour:08")).toBe(true);
    expect(suspects.some((s) => goldIds.has(s.id))).toBe(false);
  });

  it("las sospechas no tocan las familias de duración — no hay fecha de cierre que usar", () => {
    const shadow = toShadowTrades(shadowCell(MIN_SHADOW_N + 40, 4));
    const { suspects } = scanCells([], NOW, shadow);
    expect(suspects.some((s) => s.id.startsWith("hold:") || s.id.includes("-hold:"))).toBe(false);
  });

  it("una sospecha perdedora no se registra: sospechamos de oro, no de basura", () => {
    const losing = toShadowTrades(
      Array.from({ length: MIN_SHADOW_N + 40 }, (_, i) =>
        shadowRow({ simulatedPnl: -8, decidedAt: NOW - (i % 20) * DAY }),
      ),
    );
    expect(scanCells([], NOW, losing).suspects).toEqual([]);
  });
});

describe("applyScan — el embudo de tres niveles", () => {
  const suspectScan = () => {
    const shadow = toShadowTrades(shadowCell(MIN_SHADOW_N + 40, 4));
    return scanCells([], NOW, shadow);
  };

  it("una sospecha entra en estado 'sospecha', nunca 'candidata'", () => {
    const { rows, events } = applyScan([], suspectScan(), NOW);
    expect(rows.every((r) => r.status === "sospecha")).toBe(true);
    expect(events.map((e) => e.action)).toContain("sospecha");
  });

  it("🔒 LA GARANTÍA: por muchos escaneos que aguante, jamás se activa sola", () => {
    let rows: CellRow[] = [];
    for (let i = 0; i < 8; i++) rows = applyScan(rows, suspectScan(), NOW + i * DAY).rows;
    expect(rows.some((r) => r.status === "activa")).toBe(false);
    expect(rows.every((r) => r.evidenceSource === "shadow")).toBe(true);
  });

  it("cuando llegan copias REALES, la sospecha se gradúa a candidata", () => {
    const first = applyScan([], suspectScan(), NOW);
    const real = Array.from({ length: 40 }, (_, i) =>
      realTrade({ daysAgo: i % 10, utcHour: MORNING_UTC, pnl: i % 4 === 0 ? -2 : 2, question: "LoL: G2 vs T1 bo3", price: 0.25 }),
    );
    const withReal = scanCells(real, NOW);
    const promoted = applyScan(first.rows, withReal, NOW + DAY);

    const graduated = promoted.rows.filter((r) => r.evidenceSource === "real" && r.realN > 0);
    expect(graduated.length).toBeGreaterThan(0);
    expect(graduated.every((r) => r.status !== "sospecha")).toBe(true);
    expect(promoted.events.map((e) => e.action)).toContain("confirmada-real");
  });
});

describe("applyScan — ausencia de evidencia NO es evidencia de ausencia", () => {
  const seedRow = (id: string): CellRow => ({
    id,
    kind: "gold",
    label: cellLabel(parseCellId(id)!),
    params: parseCellId(id)!,
    status: "activa",
    hits: 2,
    misses: 0,
    windows: null,
    evidenceSource: "real",
    realN: 0,
    firstSeenAt: NOW,
    activatedAt: NOW,
    retiredAt: null,
  });

  it("🔒 EL BUG QUE HABRÍA MATADO LA ESTRATEGIA: una celda sin muestra no se poda", () => {
    // Restarting from zero, no book has 30 settled trades yet. Striking cells for
    // silence would have retired every seed within two daily cuts.
    let rows = [seedRow("hour:08"), seedRow("cat-band:esports:p00")];
    for (let i = 0; i < 5; i++) rows = applyScan(rows, scanCells([], NOW + i * DAY), NOW + i * DAY).rows;
    expect(rows.every((r) => r.status === "activa")).toBe(true);
  });

  it("pero una celda CON muestra que ya no rinde sí se poda", () => {
    // Neither gold (≥ +5%) nor trap (≤ −5%): it simply stopped paying. That is
    // the case pruning exists for, and it must still fire.
    const mediocre = Array.from({ length: 40 }, (_, i) =>
      realTrade({ daysAgo: i % 10, utcHour: MORNING_UTC, pnl: i % 2 === 0 ? 2 : -2 }),
    );
    let rows = [seedRow("hour:08")];
    for (let i = 0; i < MISSES_TO_RETIRE; i++) {
      rows = applyScan(rows, scanCells(mediocre, NOW + i * DAY), NOW + i * DAY).rows;
    }
    expect(rows.find((r) => r.id === "hour:08")!.status).toBe("retirada");
  });
});

describe("verdictFromCells — el presupuesto de exploración", () => {
  const suspect = (id: string, realN = 0): CellRow => ({
    id,
    kind: "gold",
    label: cellLabel(parseCellId(id)!),
    params: parseCellId(id)!,
    status: "sospecha",
    hits: 3,
    misses: 0,
    windows: { all: { n: 300, roi: 0.2, winRate: 0.6, pnl: 60, lcb: 0.1, strictLcb: 0.05, avgHoldHours: null, roiPerDay: null } },
    evidenceSource: "shadow",
    realN,
    firstSeenAt: NOW,
    activatedAt: null,
    retiredAt: null,
  });

  const input = { arm: "core" as const, category: "esports" as const, hourInAppTz: 9, entryPrice: 0.25 };

  it("sin tirada de exploración, una sospecha NUNCA copia", () => {
    expect(verdictFromCells([suspect("cat-band:esports:p00")], input).gold).toBe(false);
  });

  it("dentro del presupuesto, copia y queda marcada como exploratoria", () => {
    const v = verdictFromCells([suspect("cat-band:esports:p00")], { ...input, exploreRoll: 0.01 });
    expect(v.gold).toBe(true);
    expect(v.exploratory).toBe(true);
    expect(v.ruleId).toBe("cat-band:esports:p00");
  });

  it("fuera del presupuesto, no copia — el 12% es un techo real", () => {
    const v = verdictFromCells([suspect("cat-band:esports:p00")], { ...input, exploreRoll: EXPLORE_BUDGET + 0.01 });
    expect(v.gold).toBe(false);
  });

  it("explora la celda MENOS conocida: donde la copia compra más información", () => {
    const cells = [suspect("cat-band:esports:p00", 25), suspect("cat-hour:esports:08", 2)];
    const v = verdictFromCells(cells, { ...input, exploreRoll: 0.01 });
    expect(v.ruleId).toBe("cat-hour:esports:08");
  });

  it("🚫 una trampa activa veta la exploración: explorar es para lo desconocido", () => {
    const trap: CellRow = { ...suspect("cat-hour:esports:08"), kind: "trap", status: "activa" };
    const v = verdictFromCells([suspect("cat-band:esports:p00"), trap], { ...input, exploreRoll: 0.01 });
    expect(v.gold).toBe(false);
    expect(v.reason).toMatch(/trampa/);
  });

  it("el oro confirmado siempre gana a la exploración, y no se marca exploratoria", () => {
    const gold: CellRow = { ...suspect("cat-band:esports:p00"), status: "activa", evidenceSource: "real" };
    const v = verdictFromCells([gold, suspect("cat-hour:esports:08")], { ...input, exploreRoll: 0.01 });
    expect(v.gold).toBe(true);
    expect(v.exploratory).toBeUndefined();
    expect(v.ruleId).toBe("cat-band:esports:p00");
  });

  it("las categorías excluidas siguen excluidas, también para explorar", () => {
    const v = verdictFromCells([suspect("cat-band:cripto:p00")], {
      ...input,
      category: "cripto",
      exploreRoll: 0.01,
    });
    expect(v.gold).toBe(false);
  });
});
