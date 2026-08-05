import { describe, expect, it } from "vitest";
import {
  applyScan,
  cellId,
  cellLabel,
  parseCellId,
  scanCells,
  verdictFromCells,
  HITS_TO_ACTIVATE,
  MAX_ACTIVE_GOLD,
  MISSES_TO_RETIRE,
  type CellRow,
  type CellScan,
  type WindowStats,
  type ScanTrade,
} from "@/lib/goldEngine";

// APP_TZ is America/Caracas (UTC-4): a Date at 13:00Z opens at 09:00 local,
// i.e. inside the Mañana 08-11 block. 01:00Z lands at 21:00 local (Noche).
const NOW = Date.UTC(2026, 6, 20, 16, 0, 0);
const MORNING_UTC_HOUR = 13; // 09:00 Caracas
const NIGHT_UTC_HOUR = 1; // 21:00 Caracas

function trade(o: {
  daysAgo: number;
  utcHour: number;
  pnl: number;
  question?: string;
  price?: number;
  track?: string;
}): ScanTrade {
  const base = new Date(NOW - o.daysAgo * 24 * 3600 * 1000);
  base.setUTCHours(o.utcHour, 30, 0, 0);
  return {
    track: o.track ?? "core",
    entryPrice: o.price ?? 0.65,
    simulatedPositionSize: 5,
    realizedPnl: o.pnl,
    openedAt: base,
    marketQuestion: o.question ?? "Team A vs. Team B",
  };
}

describe("scanCells — la derivación", () => {
  it("una franja consistentemente verde con n≥30 sale como celda de oro", () => {
    const trades = Array.from({ length: 40 }, (_, i) =>
      trade({ daysAgo: i % 10, utcHour: MORNING_UTC_HOUR, pnl: i % 4 === 0 ? -2 : 2 }),
    );
    const { gold } = scanCells(trades, NOW);
    expect(gold.map((g) => g.id)).toContain("hour:08");
    const cell = gold.find((g) => g.id === "hour:08")!;
    expect(cell.windows.all.n).toBe(40);
    expect(cell.windows.all.roi).toBeGreaterThan(0.05);
  });

  it("una celda roja en toda ventana con n≥30 sale como TRAMPA", () => {
    const trades = Array.from({ length: 32 }, (_, i) =>
      trade({ daysAgo: i % 8, utcHour: NIGHT_UTC_HOUR, pnl: -2, question: "LoL: G2 vs T1 bo3" }),
    );
    const { gold, traps } = scanCells(trades, NOW);
    expect(traps.map((t) => t.id)).toContain("cat-hour:esports:20");
    expect(gold).toHaveLength(0);
  });

  it("positiva en total pero ROJA en la ventana de 7 días NO es oro — el estándar es TODAS las ventanas", () => {
    const oldWins = Array.from({ length: 25 }, (_, i) => trade({ daysAgo: 18 + (i % 3), utcHour: MORNING_UTC_HOUR, pnl: 2 }));
    const recentLosses = Array.from({ length: 12 }, (_, i) => trade({ daysAgo: i % 5, utcHour: MORNING_UTC_HOUR, pnl: -2 }));
    const { gold } = scanCells([...oldWins, ...recentLosses], NOW);
    expect(gold.map((g) => g.id)).not.toContain("hour:08");
  });

  it("n<30 no alcanza ni para oro ni para trampa — sin muestra no hay veredicto", () => {
    const trades = Array.from({ length: 20 }, (_, i) => trade({ daysAgo: i % 6, utcHour: MORNING_UTC_HOUR, pnl: 3 }));
    const { gold, traps } = scanCells(trades, NOW);
    expect(gold).toHaveLength(0);
    expect(traps).toHaveLength(0);
  });

  it("clima y cripto no entran NUNCA al escaneo — no son copiables", () => {
    const trades = Array.from({ length: 50 }, (_, i) =>
      trade({ daysAgo: i % 10, utcHour: MORNING_UTC_HOUR, pnl: 5, question: "Bitcoin close above $120k?" }),
    );
    const { gold, traps } = scanCells(trades, NOW);
    expect(gold).toHaveLength(0);
    expect(traps).toHaveLength(0);
  });

  it("las celdas por brazo existen: la veta de Cuota que el híbrido no veía ahora es candidata", () => {
    const trades = Array.from({ length: 36 }, (_, i) =>
      trade({ daysAgo: i % 9, utcHour: MORNING_UTC_HOUR, pnl: 2, track: "trade", price: 0.35 }),
    );
    const { gold } = scanCells(trades, NOW);
    expect(gold.map((g) => g.id)).toContain("arm-band:trade:p30");
  });
});

describe("cell ids", () => {
  it("id ↔ params round-trip para cada familia", () => {
    for (const id of ["hour:08", "cat-hour:esports:00", "cat-band:esports:p00", "arm-band:trade:p30", "arm-hour:live:12", "band-hour:p60:08"]) {
      const params = parseCellId(id);
      expect(params).not.toBeNull();
      expect(cellId(params!)).toBe(id);
      expect(cellLabel(params!).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Hysteresis
// ---------------------------------------------------------------------------

/** A WindowStats with the bounds filled in the way a real scan would. */
function win(n: number, roi: number, pnl: number): WindowStats {
  return { n, roi, winRate: 0.6, pnl, lcb: roi / 2, strictLcb: roi / 4, avgHoldHours: 3, roiPerDay: roi * 8 };
}

function fakeScan(id: string, roi = 0.2): CellScan {
  const params = parseCellId(id)!;
  return {
    id,
    label: cellLabel(params),
    params,
    windows: { all: win(50, roi, 50 * 5 * roi) },
    source: "real",
  };
}

describe("applyScan — el ciclo pre-registrado", () => {
  it(`una celda nueva es candidata y se activa tras ${HITS_TO_ACTIVATE} escaneos seguidos`, () => {
    const s1 = applyScan([], { gold: [fakeScan("hour:08")], traps: [] }, NOW);
    expect(s1.rows[0].status).toBe("candidata");
    expect(s1.events.map((e) => e.action)).toContain("candidata");

    const s2 = applyScan(s1.rows, { gold: [fakeScan("hour:08")], traps: [] }, NOW + 1);
    expect(s2.rows[0].status).toBe("activa");
    expect(s2.events.map((e) => e.action)).toContain("activada");
  });

  it(`una celda activa se poda tras ${MISSES_TO_RETIRE} escaneos seguidos fallando — un mal día no la mata`, () => {
    const active: CellRow = { ...applyScan([], { gold: [fakeScan("hour:08")], traps: [] }, NOW).rows[0], status: "activa", activatedAt: NOW };
    const miss1 = applyScan([active], { gold: [], traps: [] }, NOW + 1);
    expect(miss1.rows[0].status).toBe("activa"); // still in — one bad scan is noise
    expect(miss1.events).toHaveLength(0);

    const miss2 = applyScan(miss1.rows, { gold: [], traps: [] }, NOW + 2);
    expect(miss2.rows[0].status).toBe("retirada");
    expect(miss2.events.map((e) => e.action)).toContain("podada");
  });

  it("un solo escaneo bueno no salva una racha: el contador de hits se reinicia al fallar", () => {
    const s1 = applyScan([], { gold: [fakeScan("hour:08")], traps: [] }, NOW);
    const miss = applyScan(s1.rows, { gold: [], traps: [] }, NOW + 1);
    expect(miss.rows[0].hits).toBe(0);
    const s2 = applyScan(miss.rows, { gold: [fakeScan("hour:08")], traps: [] }, NOW + 2);
    expect(s2.rows[0].status).toBe("candidata"); // back to 1 hit, not activated
  });

  it("una celda podada puede REACTIVARSE si vuelve a sobrevivir dos escaneos", () => {
    const retired: CellRow = { ...applyScan([], { gold: [fakeScan("hour:08")], traps: [] }, NOW).rows[0], status: "retirada", retiredAt: NOW, hits: 0, misses: 2 };
    const s1 = applyScan([retired], { gold: [fakeScan("hour:08")], traps: [] }, NOW + 1);
    expect(s1.rows[0].status).toBe("retirada");
    const s2 = applyScan(s1.rows, { gold: [fakeScan("hour:08")], traps: [] }, NOW + 2);
    expect(s2.rows[0].status).toBe("activa");
    expect(s2.events.map((e) => e.action)).toContain("reactivada");
  });

  it(`el cupo de ${MAX_ACTIVE_GOLD} celdas evita que "todo sea oro"`, () => {
    const ids = ["00", "04", "08", "12", "16", "20"].flatMap((h) => [`hour:${h}`, `band-hour:p60:${h}`]);
    expect(ids).toHaveLength(MAX_ACTIVE_GOLD);
    const full: CellRow[] = ids.map((id) => ({ ...applyScan([], { gold: [fakeScan(id)], traps: [] }, NOW).rows[0], status: "activa" as const, activatedAt: NOW }));
    // two consecutive scans with the newcomer qualifying
    const survivors = () => ({ gold: [...ids.map((id) => fakeScan(id)), fakeScan("cat-band:esports:p00")], traps: [] });
    const s1 = applyScan(full, survivors(), NOW + 1);
    const s2 = applyScan(s1.rows, survivors(), NOW + 2);
    const newcomer = s2.rows.find((r) => r.id === "cat-band:esports:p00")!;
    expect(newcomer.status).toBe("candidata"); // qualifies but the cap is full
    expect(s2.events.map((e) => e.action)).toContain("en-espera");
  });

  it("los vetos (trampas) siguen el mismo ciclo que el oro", () => {
    const s1 = applyScan([], { gold: [], traps: [fakeScan("cat-hour:esports:20", -0.2)] }, NOW);
    const s2 = applyScan(s1.rows, { gold: [], traps: [fakeScan("cat-hour:esports:20", -0.2)] }, NOW + 1);
    expect(s2.rows[0].kind).toBe("trap");
    expect(s2.rows[0].status).toBe("activa");
  });
});

// ---------------------------------------------------------------------------
// Runtime verdict
// ---------------------------------------------------------------------------

function activeCell(id: string, kind: "gold" | "trap", roi = 0.2): CellRow {
  const params = parseCellId(id)!;
  return {
    id,
    kind,
    label: cellLabel(params),
    params,
    status: "activa",
    hits: 2,
    misses: 0,
    windows: { all: win(50, roi, 10) },
    evidenceSource: "real",
    realN: 50,
    firstSeenAt: NOW,
    activatedAt: NOW,
    retiredAt: null,
  };
}

describe("verdictFromCells — el veredicto en vivo", () => {
  const cells = [activeCell("hour:08", "gold", 0.15), activeCell("cat-band:esports:p00", "gold", 0.22), activeCell("cat-hour:esports:20", "trap", -0.2)];

  it("una jugada en celda de oro activa entra, con la celda más fuerte como atribución", () => {
    const v = verdictFromCells(cells, { arm: "core", category: "esports", hourInAppTz: 9, entryPrice: 0.25 });
    expect(v.gold).toBe(true);
    expect(v.ruleId).toBe("cat-band:esports:p00"); // 22% beats 15% — sharpest claim wins
  });

  it("la TRAMPA veta aunque una celda de oro invite — esports barato de noche no entra", () => {
    const v = verdictFromCells(cells, { arm: "core", category: "esports", hourInAppTz: 21, entryPrice: 0.25 });
    expect(v.gold).toBe(false);
    expect(v.reason).toMatch(/trampa/);
  });

  it("clima y cripto están excluidos por encima de cualquier celda", () => {
    expect(verdictFromCells(cells, { arm: "core", category: "cripto", hourInAppTz: 9, entryPrice: 0.65 }).gold).toBe(false);
    expect(verdictFromCells(cells, { arm: "core", category: "clima", hourInAppTz: 9, entryPrice: 0.65 }).gold).toBe(false);
  });

  it("sin celda que aplique no hay entrada, con motivo legible", () => {
    const v = verdictFromCells(cells, { arm: "core", category: "deportes", hourInAppTz: 13, entryPrice: 0.65 });
    expect(v.gold).toBe(false);
    expect(v.reason).toMatch(/ninguna celda/);
  });

  it("una celda con brazo fijado solo aplica a ese brazo", () => {
    const armCell = [activeCell("arm-band:trade:p30", "gold")];
    expect(verdictFromCells(armCell, { arm: "trade", category: "deportes", hourInAppTz: 13, entryPrice: 0.35 }).gold).toBe(true);
    expect(verdictFromCells(armCell, { arm: "core", category: "deportes", hourInAppTz: 13, entryPrice: 0.35 }).gold).toBe(false);
  });

  it("las celdas retiradas no opinan", () => {
    const retired = [{ ...activeCell("hour:08", "gold"), status: "retirada" as const }];
    expect(verdictFromCells(retired, { arm: "core", category: "deportes", hourInAppTz: 9, entryPrice: 0.65 }).gold).toBe(false);
  });
});
