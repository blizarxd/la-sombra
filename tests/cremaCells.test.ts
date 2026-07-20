import { describe, expect, it } from "vitest";
import { isCremaGoldCell } from "@/lib/cremaCells";

// Hour buckets (APP_TZ): madrugada 0-3, amanecer 4-7, mañana 8-11,
// mediodía 12-15, tarde 16-19, noche 20-23.
//
// The rule set was DERIVED from a full matrix scan across four windows
// (todo/30d/15d/7d), keeping only cells positive in every one with n>=30.
// These tests pin that derivation so a future loosening has to argue with it.

describe("regla 1 — Mañana 08-11 (el oro transversal)", () => {
  it("cualquier categoría en la mañana es oro — el patrón más repetido del sistema", () => {
    for (const h of [8, 9, 10, 11]) {
      expect(isCremaGoldCell("deportes", h, 0.65).gold).toBe(true);
      expect(isCremaGoldCell("esports", h, 0.8).gold).toBe(true);
      expect(isCremaGoldCell("otros", h, 0.5).gold).toBe(true);
    }
  });

  it("la mañana manda sobre la banda: incluso una banda floja entra si es 08-11", () => {
    // Morning is gold at the ARM level (+21.6% pre, n=192) across bands, so the
    // window alone qualifies — that is the whole point of rule 1.
    expect(isCremaGoldCell("deportes", 9, 0.5).gold).toBe(true);
    expect(isCremaGoldCell("deportes", 10, 0.25).gold).toBe(true);
  });

  it("una hora antes o después de la ventana NO es oro", () => {
    expect(isCremaGoldCell("deportes", 7, 0.65).gold).toBe(false);
    expect(isCremaGoldCell("deportes", 12, 0.65).gold).toBe(false);
  });
});

describe("regla 2 — esports ≤29¢ fuera de la noche", () => {
  it("esports barato es oro en madrugada, amanecer, mediodía y tarde", () => {
    for (const h of [2, 6, 13, 18]) {
      expect(isCremaGoldCell("esports", h, 0.25).gold).toBe(true);
    }
  });

  it("el corte es 29¢: 30-44¢ ya NO entra (no sobrevivió todas las ventanas)", () => {
    expect(isCremaGoldCell("esports", 13, 0.29).gold).toBe(true);
    expect(isCremaGoldCell("esports", 13, 0.3).gold).toBe(false);
    expect(isCremaGoldCell("esports", 13, 0.4).gold).toBe(false);
  });

  it("la banda 45-59¢ «moneda al aire» queda fuera — pierde en papel y en real", () => {
    // Ojo: la madrugada (00-03) NO entra en esta prueba porque la regla 3 toma
    // esports a cualquier banda en esa franja (+20.3%, n=87). La exclusión de
    // la banda floja aplica en el resto del día.
    for (const h of [6, 13, 18]) {
      expect(isCremaGoldCell("esports", h, 0.5).gold).toBe(false);
      expect(isCremaGoldCell("deportes", h, 0.5).gold).toBe(false);
    }
  });

  it("la madrugada es la excepción declarada: esports 45-59¢ SÍ entra ahí, por la regla 3", () => {
    const v = isCremaGoldCell("esports", 2, 0.5);
    expect(v.gold).toBe(true);
    expect(v.rule).toBe("esports-madrugada");
  });

  it("esports barato de NOCHE no es oro — la única franja donde esports se pone rojo", () => {
    expect(isCremaGoldCell("esports", 21, 0.25).gold).toBe(false);
    expect(isCremaGoldCell("esports", 23, 0.2).gold).toBe(false);
  });
});

describe("regla 3 — esports en madrugada 00-03", () => {
  it("esports en madrugada es oro a cualquier banda (+20.3%, n=87)", () => {
    for (const h of [0, 1, 2, 3]) {
      expect(isCremaGoldCell("esports", h, 0.7).gold).toBe(true);
    }
  });

  it("pero solo esports: deportes en madrugada no entra", () => {
    expect(isCremaGoldCell("deportes", 2, 0.7).gold).toBe(false);
  });
});

describe("lo que se PODÓ el 20-jul (no debe volver por accidente)", () => {
  /**
   * Tarde was half the old band rule. The scan shows it is not a consistent
   * winner by arm (Cuota -12.5%, En Vivo +1.9%); its only strong cell is
   * "tarde x jueves", a single weekday = noise.
   */
  it("la TARDE 16-19 ya no es una ventana de oro por sí sola", () => {
    expect(isCremaGoldCell("deportes", 17, 0.7).gold).toBe(false);
    expect(isCremaGoldCell("otros", 18, 0.8).gold).toBe(false);
  });

  it("la banda 60-89¢ fuera de la mañana ya no entra sola", () => {
    expect(isCremaGoldCell("deportes", 13, 0.7).gold).toBe(false); // mediodía
    expect(isCremaGoldCell("deportes", 6, 0.8).gold).toBe(false); // amanecer
  });
});

describe("excluidos duros", () => {
  it("clima y cripto nunca son oro, ni siquiera en la mañana", () => {
    expect(isCremaGoldCell("clima", 9, 0.7).gold).toBe(false);
    expect(isCremaGoldCell("cripto", 9, 0.7).gold).toBe(false);
    expect(isCremaGoldCell("clima", 2, 0.25).gold).toBe(false);
  });
});

describe("trazabilidad", () => {
  it("cada veredicto dice qué regla disparó, para juzgar celda por celda", () => {
    expect(isCremaGoldCell("deportes", 9, 0.65).rule).toBe("mañana");
    expect(isCremaGoldCell("esports", 13, 0.25).rule).toBe("esports-barato");
    expect(isCremaGoldCell("esports", 2, 0.7).rule).toBe("esports-madrugada");
    expect(isCremaGoldCell("deportes", 13, 0.7).rule).toBeUndefined();
  });

  it("cada veredicto trae un motivo legible", () => {
    expect(isCremaGoldCell("deportes", 9, 0.65).reason).toMatch(/Mañana/);
    expect(isCremaGoldCell("esports", 13, 0.25).reason).toMatch(/esports/);
    expect(isCremaGoldCell("clima", 9, 0.7).reason).toMatch(/excluida/);
  });
});
