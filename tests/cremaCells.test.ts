import { describe, expect, it } from "vitest";
import { canonicalGoldRule, goldRuleLabel, seedCells } from "@/lib/cremaCells";
import { verdictFromCells, type VerdictInput } from "@/lib/goldEngine";

// Hour buckets (APP_TZ): madrugada 0-3, amanecer 4-7, mañana 8-11,
// mediodía 12-15, tarde 16-19, noche 20-23.
//
// The SEED rule set is the frozen 2026-07-20 manual matrix scan (4 windows,
// positive in every one with n>=30). Since that day the LIVE set self-evolves
// in the crema_cells table; the seeds bootstrap it and serve as fallback, and
// these tests pin that the seeds encode exactly the behavior that was derived.

const seeds = seedCells();
const v = (category: VerdictInput["category"], hour: number, price: number, arm: VerdictInput["arm"] = "core") =>
  verdictFromCells(seeds, { arm, category, hourInAppTz: hour, entryPrice: price });

describe("semilla 1 — Mañana 08-11 (el oro transversal)", () => {
  it("cualquier categoría en la mañana es oro — el patrón más repetido del sistema", () => {
    for (const h of [8, 9, 10, 11]) {
      expect(v("deportes", h, 0.65).gold).toBe(true);
      expect(v("esports", h, 0.8).gold).toBe(true);
      expect(v("otros", h, 0.5).gold).toBe(true);
    }
  });

  it("la mañana manda sobre la banda: incluso una banda floja entra si es 08-11", () => {
    expect(v("deportes", 9, 0.5).gold).toBe(true);
    expect(v("deportes", 10, 0.25).gold).toBe(true);
  });

  it("una hora antes o después de la ventana NO es oro", () => {
    expect(v("deportes", 7, 0.65).gold).toBe(false);
    expect(v("deportes", 12, 0.65).gold).toBe(false);
  });
});

describe("semilla 2 — esports ≤29¢ fuera de la noche", () => {
  it("esports barato es oro en madrugada, amanecer, mediodía y tarde", () => {
    for (const h of [2, 6, 13, 18]) {
      expect(v("esports", h, 0.25).gold).toBe(true);
    }
  });

  it("el corte es 29¢: 30-44¢ ya NO entra (no sobrevivió todas las ventanas)", () => {
    expect(v("esports", 13, 0.29).gold).toBe(true);
    expect(v("esports", 13, 0.3).gold).toBe(false);
    expect(v("esports", 13, 0.4).gold).toBe(false);
  });

  it("la banda 45-59¢ «moneda al aire» queda fuera — pierde en papel y en real", () => {
    // La madrugada (00-03) no entra aquí porque la semilla 3 toma esports a
    // cualquier banda en esa franja. La exclusión aplica al resto del día.
    for (const h of [6, 13, 18]) {
      expect(v("esports", h, 0.5).gold).toBe(false);
      expect(v("deportes", h, 0.5).gold).toBe(false);
    }
  });

  it("esports barato de NOCHE no es oro — la celda TRAMPA nocturna lo veta", () => {
    const verdict = v("esports", 21, 0.25);
    expect(verdict.gold).toBe(false);
    expect(verdict.reason).toMatch(/trampa/);
    expect(v("esports", 23, 0.2).gold).toBe(false);
  });
});

describe("semilla 3 — esports en madrugada 00-03", () => {
  it("esports en madrugada es oro a cualquier banda (+20.3%, n=87)", () => {
    for (const h of [0, 1, 2, 3]) {
      expect(v("esports", h, 0.7).gold).toBe(true);
    }
  });

  it("la madrugada es la excepción declarada: esports 45-59¢ SÍ entra ahí", () => {
    const verdict = v("esports", 2, 0.5);
    expect(verdict.gold).toBe(true);
    expect(verdict.ruleId).toBe("cat-hour:esports:00");
  });

  it("pero solo esports: deportes en madrugada no entra", () => {
    expect(v("deportes", 2, 0.7).gold).toBe(false);
  });
});

describe("lo que se PODÓ el 20-jul (no debe volver por accidente en las semillas)", () => {
  it("la TARDE 16-19 ya no es una ventana de oro por sí sola", () => {
    expect(v("deportes", 17, 0.7).gold).toBe(false);
    expect(v("otros", 18, 0.8).gold).toBe(false);
  });

  it("la banda 60-89¢ fuera de la mañana ya no entra sola", () => {
    expect(v("deportes", 13, 0.7).gold).toBe(false); // mediodía
    expect(v("deportes", 6, 0.8).gold).toBe(false); // amanecer
  });
});

describe("excluidos duros", () => {
  it("clima y cripto nunca son oro, ni siquiera en la mañana", () => {
    expect(v("clima", 9, 0.7).gold).toBe(false);
    expect(v("cripto", 9, 0.7).gold).toBe(false);
    expect(v("clima", 2, 0.25).gold).toBe(false);
  });
});

describe("trazabilidad y continuidad", () => {
  it("cada veredicto dice qué celda disparó, para juzgar celda por celda", () => {
    expect(v("deportes", 9, 0.65).ruleId).toBe("hour:08");
    expect(v("esports", 13, 0.25).ruleId).toBe("cat-band:esports:p00");
    expect(v("esports", 2, 0.7).ruleId).toBe("cat-hour:esports:00");
    expect(v("deportes", 13, 0.7).ruleId).toBeUndefined();
  });

  it("los sellos viejos (nombres humanos) mapean a su celda canónica — una sola fila por celda en el tablero", () => {
    expect(canonicalGoldRule("mañana")).toBe("hour:08");
    expect(canonicalGoldRule("esports-barato")).toBe("cat-band:esports:p00");
    expect(canonicalGoldRule("esports-madrugada")).toBe("cat-hour:esports:00");
    expect(canonicalGoldRule("banda-ventana")).toBe("banda-ventana"); // retired, stays itself
  });

  it("toda etiqueta es legible: celdas del motor y reglas retiradas por igual", () => {
    expect(goldRuleLabel("mañana")).toMatch(/Mañana/);
    expect(goldRuleLabel("cat-band:esports:p00")).toMatch(/Esports/);
    expect(goldRuleLabel("banda-ventana")).toMatch(/retirada/);
    expect(goldRuleLabel("regla-v1")).toMatch(/⚠️/);
  });
});
