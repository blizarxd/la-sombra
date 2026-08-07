import { describe, expect, it } from "vitest";
import {
  DIMS,
  FINE_BANDS,
  PRICE_BANDS,
  SWEET_BAND_KEYS,
  buildAllMatrices,
  buildMatrix,
  confluenceBandKey,
  fineBandKey,
  priceBandKey,
  type SettledTrade,
} from "@/lib/slices";

/**
 * The fine bands exist because the coarse ones hid the finding: 55–59¢ was the
 * best slice in the book and lived inside the band we had written off, while
 * 70–74¢ lost money inside the band we had crowned. These tests pin the
 * boundaries exactly, because a one-cent slip moves trades between "the vein"
 * and "the trap".
 */

const base = Date.parse("2026-08-01T14:00:00Z");

function trade(entryPrice: number, realizedPnl = 1, over: Partial<SettledTrade> = {}): SettledTrade {
  return {
    track: "trade",
    entryPrice,
    simulatedPositionSize: 5,
    realizedPnl,
    openedAt: base,
    marketQuestion: "Team A vs Team B",
    resolvedAt: base + 3 * 3_600_000,
    ...over,
  };
}

describe("fineBandKey — los bordes exactos", () => {
  it("clasifica cada tramo por su borde inferior", () => {
    expect(fineBandKey(0.2)).toBe("f00");
    expect(fineBandKey(0.44)).toBe("f00");
    expect(fineBandKey(0.45)).toBe("f45");
    expect(fineBandKey(0.54)).toBe("f45");
    expect(fineBandKey(0.55)).toBe("f55");
    expect(fineBandKey(0.59)).toBe("f55");
    expect(fineBandKey(0.6)).toBe("f60");
    expect(fineBandKey(0.69)).toBe("f60");
    expect(fineBandKey(0.7)).toBe("f70");
    expect(fineBandKey(0.74)).toBe("f70");
    expect(fineBandKey(0.75)).toBe("f75");
    expect(fineBandKey(0.99)).toBe("f75");
  });

  it("precios imposibles no caen en ninguna banda", () => {
    expect(fineBandKey(0)).toBeNull();
    expect(fineBandKey(1.2)).toBeNull();
    expect(fineBandKey(-0.5)).toBeNull();
    expect(fineBandKey(NaN)).toBeNull();
  });

  it("toda clave devuelta existe en el eje", () => {
    const keys = new Set(FINE_BANDS.map((b) => b.key));
    for (const p of [0.1, 0.3, 0.46, 0.56, 0.62, 0.71, 0.8, 0.95]) {
      expect(keys.has(fineBandKey(p)!)).toBe(true);
    }
  });

  it("la banda dulce son 55–69¢, los dos tramos que rindieron", () => {
    expect(SWEET_BAND_KEYS).toEqual(["f55", "f60"]);
    expect(fineBandKey(0.57)).toBe("f55");
    expect(fineBandKey(0.65)).toBe("f60");
    // ...y 70–74 queda FUERA, que es medio hallazgo por sí solo.
    expect(SWEET_BAND_KEYS).not.toContain(fineBandKey(0.72));
  });
});

describe("por qué hacían falta: lo que la banda ancha escondía", () => {
  it("55–59¢ vivía dentro de «45–59¢ · moneda al aire», la banda descartada", () => {
    expect(priceBandKey(0.57)).toBe("p45"); // coarse: written off
    expect(fineBandKey(0.57)).toBe("f55"); // fine: the best slice in the book
  });

  it("70–74¢ vivía dentro de «60–74¢», la banda coronada — y pierde", () => {
    expect(priceBandKey(0.72)).toBe("p60"); // coarse: crowned
    expect(fineBandKey(0.72)).toBe("f70"); // fine: flagged
  });

  it("🔒 NO redefine PRICE_BANDS: los ids de celdas de oro seguirían válidos", () => {
    // Renumbering the coarse bands would orphan every `cat-band:x:p60` stamped
    // on a paper trade and erase the strategy's own history.
    expect(PRICE_BANDS.map((b) => b.key)).toEqual(["p00", "p30", "p45", "p60", "p75", "p90"]);
  });
});

describe("la matriz de banda fina", () => {
  const spec = { id: "t", title: "t", hint: "t", minSample: 8, rowDim: DIMS.fineBand, colDim: DIMS.track };

  it("separa el tramo dulce del tramo trampa en filas distintas", () => {
    const m = buildMatrix(
      [
        ...Array.from({ length: 20 }, () => trade(0.57, 2)), // the vein
        ...Array.from({ length: 20 }, () => trade(0.72, -2)), // the trap
      ],
      spec,
    );
    const sweet = m.rows.find((r) => r.key === "f55")!.cells.trade!;
    const trap = m.rows.find((r) => r.key === "f70")!.cells.trade!;
    expect(sweet.pnl).toBeGreaterThan(0);
    expect(trap.pnl).toBeLessThan(0);
  });

  it("reproduce el hallazgo: la banda ancha da PLANO, la fina revela los dos lados", () => {
    // Same trades, both cuts. The coarse view averages the vein and the trap
    // into nothing — which is precisely how the finding stayed hidden.
    const trades = [
      ...Array.from({ length: 20 }, () => trade(0.62, 2)),
      ...Array.from({ length: 20 }, () => trade(0.72, -2)),
    ];
    const coarse = buildMatrix(trades, { ...spec, rowDim: DIMS.priceBand });
    const fine = buildMatrix(trades, spec);

    expect(coarse.rows.find((r) => r.key === "p60")!.cells.trade!.pnl).toBe(0); // averaged away
    expect(fine.rows.find((r) => r.key === "f60")!.cells.trade!.pnl).toBeGreaterThan(0);
    expect(fine.rows.find((r) => r.key === "f70")!.cells.trade!.pnl).toBeLessThan(0);
  });

  it("las dos matrices nuevas entran en el tablero", () => {
    const ids = buildAllMatrices([trade(0.57), trade(0.62)]).map((m) => m.id);
    expect(ids).toContain("fineband-track");
    expect(ids).toContain("fineband-category");
  });

  it("respeta el mínimo de muestra: 8 por celda, no 5", () => {
    const m = buildMatrix(Array.from({ length: 6 }, () => trade(0.57, 2)), spec);
    expect(m.bestPerCol.trade).toBeNull();
  });
});

describe("confluenceBandKey — el eje de confirmación independiente", () => {
  const withConf = (c: number | null | undefined) => trade(0.62, 1, { confluenceCount: c });

  it("etiqueta por billeteras TOTALES: el recuento guardado son las OTRAS", () => {
    expect(confluenceBandKey(withConf(0))).toBe("x1"); // solo nosotros
    expect(confluenceBandKey(withConf(1))).toBe("x2");
    expect(confluenceBandKey(withConf(2))).toBe("x3");
    expect(confluenceBandKey(withConf(3))).toBe("x4");
    expect(confluenceBandKey(withConf(9))).toBe("x4");
  });

  it("sin dato no cae en ninguna banda — las filas viejas no ensucian la matriz", () => {
    expect(confluenceBandKey(withConf(null))).toBeNull();
    expect(confluenceBandKey(withConf(undefined))).toBeNull();
    expect(confluenceBandKey(withConf(NaN))).toBeNull();
    expect(confluenceBandKey(withConf(-1))).toBeNull();
  });

  it("separa el trade solitario del racimo en filas distintas", () => {
    const m = buildMatrix(
      [
        ...Array.from({ length: 12 }, () => trade(0.62, -1, { confluenceCount: 0 })),
        ...Array.from({ length: 12 }, () => trade(0.62, 2, { confluenceCount: 3 })),
      ],
      { id: "t", title: "t", hint: "t", minSample: 8, rowDim: DIMS.confluence, colDim: DIMS.track },
    );
    expect(m.rows.find((r) => r.key === "x1")!.cells.trade!.pnl).toBeLessThan(0);
    expect(m.rows.find((r) => r.key === "x4")!.cells.trade!.pnl).toBeGreaterThan(0);
  });

  it("la matriz de confluencia entra en el tablero", () => {
    const ids = buildAllMatrices([trade(0.62, 1, { confluenceCount: 2 })]).map((m) => m.id);
    expect(ids).toContain("confluence-track");
  });
});
