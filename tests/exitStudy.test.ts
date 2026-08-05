import { describe, expect, it } from "vitest";
import { EXIT_POLICIES, applyPolicy, attachPaths, studyExits, type PositionPath } from "@/lib/exitStudy";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const HOUR = 3_600_000;

function pos(o: Partial<PositionPath> = {}): PositionPath {
  return {
    paperTradeId: "pt1",
    track: "core",
    stake: 10,
    heldPnl: -10,
    path: [
      { at: NOW, pnl: 1 },
      { at: NOW + HOUR, pnl: 6 }, // +60% here — a take-profit would fire
      { at: NOW + 2 * HOUR, pnl: -4 },
    ],
    ...o,
  };
}

const policy = (key: string) => EXIT_POLICIES.find((p) => p.key === key)!;

describe("applyPolicy", () => {
  it("aguantar siempre devuelve el resultado real", () => {
    expect(applyPolicy(pos(), policy("hold"))).toBe(-10);
  });

  it("tomar ganancia sale en la PRIMERA marca que cruza el umbral", () => {
    expect(applyPolicy(pos(), policy("tp50"))).toBe(6);
  });

  it("si nunca se cruza el umbral, es idéntico a aguantar", () => {
    expect(applyPolicy(pos(), policy("tp100"))).toBe(-10);
  });

  it("el stop corta en la primera marca bajo el suelo", () => {
    const p = pos({ path: [{ at: NOW, pnl: -2 }, { at: NOW + HOUR, pnl: -7 }, { at: NOW + 2 * HOUR, pnl: -9 }] });
    expect(applyPolicy(p, policy("sl50"))).toBe(-7);
  });

  it("sin camino registrado NO se inventa una salida: se aguanta", () => {
    expect(applyPolicy(pos({ path: [] }), policy("tp50"))).toBe(-10);
  });

  it("una regla con techo y suelo dispara con lo que llegue primero", () => {
    const p = pos({ path: [{ at: NOW, pnl: -6 }, { at: NOW + HOUR, pnl: 8 }] });
    expect(applyPolicy(p, policy("tp50sl50"))).toBe(-6);
  });

  it("stake cero no rompe la aritmética", () => {
    expect(() => applyPolicy(pos({ stake: 0 }), policy("tp50"))).not.toThrow();
  });
});

describe("studyExits", () => {
  it("compara cada política contra aguantar", () => {
    const positions = Array.from({ length: 20 }, (_, i) => pos({ paperTradeId: `pt${i}` }));
    const results = studyExits(positions);
    const hold = results.find((r) => r.key === "hold")!;
    const tp50 = results.find((r) => r.key === "tp50")!;

    expect(hold.vsHold).toBe(0); // holding versus holding is zero, by definition
    expect(tp50.totalPnl).toBeGreaterThan(hold.totalPnl);
    expect(tp50.vsHold).toBeGreaterThan(0);
    expect(tp50.triggered).toBe(20);
  });

  it("cuenta cuántas posiciones dispararon de verdad", () => {
    const never = Array.from({ length: 10 }, (_, i) => pos({ paperTradeId: `x${i}`, path: [{ at: NOW, pnl: 0.1 }] }));
    expect(studyExits(never).find((r) => r.key === "tp50")!.triggered).toBe(0);
  });

  it("trae la cota inferior: elegir una política por el titular es curva-ajustada", () => {
    const positions = Array.from({ length: 30 }, (_, i) => pos({ paperTradeId: `y${i}` }));
    const tp50 = studyExits(positions).find((r) => r.key === "tp50")!;
    expect(tp50.lcb!).toBeLessThan(tp50.roi);
  });

  it("sin posiciones devuelve la tabla vacía sin romperse", () => {
    const results = studyExits([]);
    expect(results).toHaveLength(EXIT_POLICIES.length);
    expect(results.every((r) => r.n === 0 && r.totalPnl === 0)).toBe(true);
  });
});

describe("attachPaths", () => {
  it("pega las marcas a su posición y las ordena en el tiempo", () => {
    const [p] = attachPaths(
      [{ paperTradeId: "a", track: "core", stake: 10, heldPnl: 2 }],
      [
        { paperTradeId: "a", pnl: 5, collectedAt: new Date(NOW + HOUR) },
        { paperTradeId: "a", pnl: 1, collectedAt: new Date(NOW) },
        { paperTradeId: "b", pnl: 9, collectedAt: new Date(NOW) },
      ],
    );
    expect(p.path.map((x) => x.pnl)).toEqual([1, 5]);
  });

  it("una posición sin marcas queda con camino vacío, no con datos de otra", () => {
    const [p] = attachPaths(
      [{ paperTradeId: "solo", track: "core", stake: 10, heldPnl: 2 }],
      [{ paperTradeId: "otra", pnl: 5, collectedAt: NOW }],
    );
    expect(p.path).toEqual([]);
  });
});
