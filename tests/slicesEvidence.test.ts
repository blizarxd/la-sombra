import { describe, expect, it } from "vitest";
import { DIMS, buildMatrix, holdBandKey, holdHours, type SettledTrade } from "@/lib/slices";

/**
 * The matrices are where a human (and the AI cut) READ the findings, so this is
 * where a fluke does its damage: a 5-trade cell used to win the 🏆 on raw ROI and
 * get repeated back as "the morning is gold". These tests pin the two repairs —
 * crowns are decided on a multiplicity-corrected floor, and capital efficiency
 * is finally visible.
 */

const HOUR = 3_600_000;
const base = Date.parse("2026-08-01T14:00:00Z"); // 10:00 Caracas — "mañana" block

function trade(over: Partial<SettledTrade> = {}): SettledTrade {
  return {
    track: "core",
    entryPrice: 0.6,
    simulatedPositionSize: 10,
    realizedPnl: 3,
    openedAt: base,
    marketQuestion: "Team A vs Team B",
    resolvedAt: base + 3 * HOUR,
    ...over,
  };
}

/** n copies of a trade with a fixed win/loss pattern, spread across hour blocks. */
function cell(n: number, winEvery: number, over: Partial<SettledTrade>, winPnl = 3, losePnl = -10) {
  return Array.from({ length: n }, (_, i) =>
    trade({ ...over, realizedPnl: i % winEvery === 0 ? losePnl : winPnl }),
  );
}

describe("holdHours / holdBandKey", () => {
  it("mide la exposición real de capital: abrir → resolver", () => {
    expect(holdHours(trade({ openedAt: base, resolvedAt: base + 6 * HOUR }))).toBe(6);
  });

  it("usa closedAt cuando no hubo resolución", () => {
    expect(holdHours(trade({ resolvedAt: null, closedAt: base + 2 * HOUR }))).toBe(2);
  });

  it("sin fecha de cierre es null — desconocido, no cero", () => {
    expect(holdHours(trade({ resolvedAt: null, closedAt: null }))).toBeNull();
    expect(holdBandKey(trade({ resolvedAt: null, closedAt: null }))).toBeNull();
  });

  it("reloj corrido hacia atrás no produce duraciones negativas", () => {
    expect(holdHours(trade({ openedAt: base, resolvedAt: base - HOUR }))).toBeNull();
  });

  it("clasifica en bandas por duración", () => {
    const at = (h: number) => holdBandKey(trade({ openedAt: base, resolvedAt: base + h * HOUR }));
    expect(at(0.5)).toBe("t00");
    expect(at(3)).toBe("t01");
    expect(at(12)).toBe("t06");
    expect(at(40)).toBe("t24");
    expect(at(200)).toBe("t72");
  });
});

describe("buildMatrix — cotas de confianza", () => {
  const spec = {
    id: "t",
    title: "t",
    hint: "t",
    minSample: 5,
    rowDim: DIMS.hourBlock,
    colDim: DIMS.track,
  };

  it("cada celda trae su piso, y el piso siempre está por debajo del ROI", () => {
    const m = buildMatrix(cell(40, 4, {}), spec);
    const c = m.rows[0].cells.core!;
    expect(c.count).toBe(40);
    expect(c.lcb!).toBeLessThan(c.roi);
    expect(c.strictLcb!).toBeLessThan(c.lcb!); // corrected floor is the harsher one
  });

  it("una celda de 1 trade no tiene piso — pero tampoco revienta la matriz", () => {
    const m = buildMatrix([trade()], { ...spec, minSample: 1 });
    const c = m.rows[0].cells.core!;
    expect(c.count).toBe(1);
    expect(c.lcb).toBeNull();
    expect(c.strictLcb).toBeNull();
  });

  it("🏆 EL ARREGLO: una celda chica y espectacular ya NO le gana a una grande y sólida", () => {
    // "madrugada": 5 trades, every one a big winner — raw ROI ~ +100%.
    const madrugada = Array.from({ length: 5 }, () =>
      trade({ openedAt: Date.parse("2026-08-01T05:00:00Z"), realizedPnl: 10 }),
    );
    // "mañana": 300 trades, 70% win rate at a modest edge — the real thing.
    const manana = Array.from({ length: 300 }, (_, i) =>
      trade({ openedAt: base, realizedPnl: i % 10 < 7 ? 4.9 : -10 }),
    );

    const m = buildMatrix([...madrugada, ...manana], spec);
    const small = m.rows.find((r) => r.key === "00")!.cells.core!;
    const big = m.rows.find((r) => r.key === "08")!.cells.core!;

    expect(small.roi).toBeGreaterThan(big.roi); // raw ROI still favours the fluke
    expect(m.bestPerCol.core).toBe("08"); // ...but the crown goes to the evidence
  });

  it("sin dos celdas que califiquen no se corona a nadie", () => {
    const m = buildMatrix(cell(10, 3, {}), spec);
    expect(m.bestPerCol.core).toBeNull();
    expect(m.worstPerCol.core).toBeNull();
  });

  it("🚫 el peor es el que no se salva ni con supuestos generosos", () => {
    const good = Array.from({ length: 60 }, (_, i) =>
      trade({ openedAt: base, realizedPnl: i % 10 < 7 ? 4.9 : -10 }),
    );
    const awful = Array.from({ length: 60 }, () =>
      trade({ openedAt: Date.parse("2026-08-01T17:00:00Z"), realizedPnl: -10 }),
    );
    const m = buildMatrix([...good, ...awful], spec);
    expect(m.worstPerCol.core).toBe("12"); // 13:00 Caracas → mediodía, the anti-vein
    expect(m.bestPerCol.core).toBe("08");
  });
});

describe("buildMatrix — ROI por día de capital", () => {
  const spec = {
    id: "t",
    title: "t",
    hint: "t",
    minSample: 5,
    rowDim: DIMS.holdBand,
    colDim: DIMS.track,
  };

  it("+8% en 4h supera a +20% en 5 días una vez medido el capital", () => {
    const fast = Array.from({ length: 30 }, () =>
      trade({ openedAt: base, resolvedAt: base + 4 * HOUR, realizedPnl: 0.8 }),
    );
    const slow = Array.from({ length: 30 }, () =>
      trade({ openedAt: base, resolvedAt: base + 120 * HOUR, realizedPnl: 2.0 }),
    );
    const m = buildMatrix([...fast, ...slow], spec);
    const f = m.rows.find((r) => r.key === "t01")!.cells.core!;
    const s = m.rows.find((r) => r.key === "t72")!.cells.core!;

    expect(f.roi).toBeLessThan(s.roi); // headline ROI says the slow one wins
    expect(f.roiPerDay!).toBeGreaterThan(s.roiPerDay!); // capital says otherwise
    expect(f.avgHoldHours).toBe(4);
  });

  it("una resolución de minutos no inventa un ROI/día de cuatro cifras", () => {
    const flash = Array.from({ length: 10 }, () =>
      trade({ openedAt: base, resolvedAt: base + 4 * 60_000, realizedPnl: 1 }),
    );
    const m = buildMatrix(flash, spec);
    const c = m.rows.find((r) => r.key === "t00")!.cells.core!;
    expect(c.roiPerDay!).toBeLessThanOrEqual(c.roi * 24); // clamped at one hour
  });

  it("sin fechas de cierre no hay métrica de capital, y se dice", () => {
    const m = buildMatrix(cell(10, 3, { resolvedAt: null, closedAt: null }), {
      ...spec,
      rowDim: DIMS.hourBlock,
    });
    const c = m.rows[0].cells.core!;
    expect(c.avgHoldHours).toBeNull();
    expect(c.roiPerDay).toBeNull();
  });
});
