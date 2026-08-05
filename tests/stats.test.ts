import { describe, expect, it } from "vitest";
import {
  Z_90,
  edgeStats,
  inverseNormalCdf,
  meanLowerBound,
  mean,
  multiplicityZ,
  stdDev,
  stdErr,
  wilsonLowerBound,
} from "@/lib/stats";

describe("basic moments", () => {
  it("media y desviación estándar muestral", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3); // n-1 denominator
  });

  it("con menos de 2 datos no hay error estándar — es desconocido, no cero", () => {
    expect(stdErr([])).toBeNull();
    expect(stdErr([0.5])).toBeNull();
    expect(stdDev([0.5])).toBe(0);
  });
});

describe("meanLowerBound", () => {
  it("null con muestra insuficiente: 'no sé' no es lo mismo que 'malo'", () => {
    expect(meanLowerBound([])).toBeNull();
    expect(meanLowerBound([0.9])).toBeNull();
  });

  it("la cota siempre queda por debajo de la media", () => {
    const xs = [0.5, -1, 0.8, 0.4, -1, 0.9, 0.3, -1, 0.6, 0.2];
    const lcb = meanLowerBound(xs)!;
    expect(lcb).toBeLessThan(mean(xs));
  });

  it("más muestra con la misma media ⇒ cota más alta (el castigo se afloja)", () => {
    const unit = [1, -1, 1, 1, -1, 1, 1, -1, 1, 1];
    const small = meanLowerBound(unit)!;
    const big = meanLowerBound([...unit, ...unit, ...unit, ...unit, ...unit, ...unit])!;
    expect(mean(unit)).toBeCloseTo(mean([...unit, ...unit]), 10); // same point estimate
    expect(big).toBeGreaterThan(small);
  });

  it("más varianza con la misma media ⇒ cota más baja", () => {
    const calm = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    const wild = [3, -2.8, 3, -2.8, 3, -2.8, 3, -2.8, 3, -2.8, 3, -2.6];
    expect(mean(wild)).toBeGreaterThan(0);
    expect(meanLowerBound(calm)!).toBeGreaterThan(meanLowerBound(wild)!);
  });

  it("una cota simple NO basta contra una celda chica y espectacular", () => {
    // Documented limitation, not an oversight. The dashboard crowned by raw ROI
    // with minSample=5; this is the shape that got crowned — five lucky longshots.
    const luckyFive = [1.0, 1.0, 1.0, -1, 1.0];
    // ...against the cell that was actually cross-validated on botpolym.
    const solid300 = Array.from({ length: 300 }, (_, i) => (i % 10 < 7 ? 0.49 : -1));

    expect(mean(luckyFive)).toBeGreaterThan(mean(solid300));
    // A 1.28σ haircut off +60% still leaves +8.7%: the noise STILL wins.
    expect(meanLowerBound(luckyFive)!).toBeGreaterThan(meanLowerBound(solid300)!);
  });
});

describe("EL CASO QUE NOS COSTÓ DINERO", () => {
  it("la corrección por multiplicidad sí invierte el orden", () => {
    // The n=5 cell only looks good because it WON A CONTEST among hundreds of
    // slices. Price that in and the ranking flips to the honest order.
    const luckyFive = [1.0, 1.0, 1.0, -1, 1.0];
    const solid300 = Array.from({ length: 300 }, (_, i) => (i % 10 < 7 ? 0.49 : -1));
    const cellsTested = 200;

    const lucky = edgeStats(luckyFive, cellsTested);
    const solid = edgeStats(solid300, cellsTested);

    expect(lucky.roi).toBeGreaterThan(solid.roi); // raw ROI: noise wins
    expect(lucky.strictLcb!).toBeLessThan(solid.strictLcb!); // corrected: fixed
  });

  it("cinco resultados IDÉNTICOS no valen como certeza — el hueco de la varianza cero", () => {
    // Sample variance of five identical wins is exactly 0. Without the prior the
    // floor would sit at +100% and the fluke would win every ranking forever.
    const perfectFive = [1, 1, 1, 1, 1];
    const s = edgeStats(perfectFive, 200);
    expect(s.roi).toBe(1);
    expect(s.lcb!).toBeLessThan(s.roi);
    expect(s.strictLcb!).toBeLessThan(0);
  });

  it("la cota estricta es demasiado dura para ser una PUERTA — solo un orden", () => {
    // Honest caveat: at n≈30 a family-wise correction rejects nearly everything.
    // If it gated the strategy, the bot would never act and never learn. It ranks.
    const decent = Array.from({ length: 40 }, (_, i) => (i % 5 < 3 ? 0.7 : -1));
    const s = edgeStats(decent, 200);
    expect(s.roi).toBeGreaterThan(0);
    expect(s.strictLcb!).toBeLessThan(0);
  });
});

describe("wilsonLowerBound", () => {
  it("null sin muestra", () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
  });

  it("100% de aciertos en 3 intentos no es 100% de confianza", () => {
    const lb = wilsonLowerBound(3, 3)!;
    expect(lb).toBeLessThan(0.75);
    expect(lb).toBeGreaterThan(0);
  });

  it("la misma tasa con más muestra sube la cota", () => {
    expect(wilsonLowerBound(90, 100)!).toBeGreaterThan(wilsonLowerBound(9, 10)!);
  });

  it("nunca devuelve negativo aunque no se acierte nada", () => {
    expect(wilsonLowerBound(0, 20)!).toBeGreaterThanOrEqual(0);
  });
});

describe("inverseNormalCdf", () => {
  it("reproduce los z conocidos", () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 6);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.6449, 3);
    expect(inverseNormalCdf(0.9)).toBeCloseTo(1.2816, 3);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.96, 3);
  });

  it("es simétrica", () => {
    expect(inverseNormalCdf(0.3)).toBeCloseTo(-inverseNormalCdf(0.7), 6);
  });
});

describe("multiplicityZ", () => {
  it("una sola prueba ≈ el z de siempre", () => {
    expect(multiplicityZ(1, 0.05)).toBeCloseTo(1.6449, 2);
  });

  it("cuantas más celdas compiten, más alta la vara", () => {
    expect(multiplicityZ(200)).toBeGreaterThan(multiplicityZ(20));
    expect(multiplicityZ(20)).toBeGreaterThan(multiplicityZ(1));
  });

  it("escanear ~200 celdas exige más de 3 sigmas", () => {
    expect(multiplicityZ(200)).toBeGreaterThan(3);
  });
});

describe("edgeStats", () => {
  it("resume una celda con cota normal y cota estricta", () => {
    const rois = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -1 : 0.6));
    const s = edgeStats(rois, 150);
    expect(s.n).toBe(60);
    expect(s.roi).toBeCloseTo(mean(rois), 10);
    expect(s.winRate).toBeCloseTo(40 / 60, 6);
    expect(s.lcb!).toBeLessThan(s.roi);
    // The multiplicity view must be the harsher of the two, always.
    expect(s.strictLcb!).toBeLessThan(s.lcb!);
    expect(s.winRateLcb!).toBeLessThan(s.winRate);
  });

  it("con n<2 las cotas son null pero el resumen no revienta", () => {
    const s = edgeStats([0.5], 10);
    expect(s.n).toBe(1);
    expect(s.lcb).toBeNull();
    expect(s.strictLcb).toBeNull();
    expect(s.winRate).toBe(1);
  });

  it("la cota encogida está por debajo de la cota sin encoger: el prior siempre cobra", () => {
    const rois = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? -1 : 0.6));
    expect(edgeStats(rois).lcb!).toBeLessThan(meanLowerBound(rois)!);
  });

  it("celda vacía: sin datos, sin veredicto", () => {
    const s = edgeStats([], 10);
    expect(s.n).toBe(0);
    expect(s.roi).toBe(0);
    expect(s.lcb).toBeNull();
    expect(s.winRateLcb).toBeNull();
  });

  it("z explícito más exigente baja la cota", () => {
    const rois = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? -1 : 0.5));
    expect(edgeStats(rois, 1, 3).lcb!).toBeLessThan(edgeStats(rois, 1, Z_90).lcb!);
  });
});
