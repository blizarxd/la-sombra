import { describe, expect, it } from "vitest";
import {
  LATENCY_LABELS,
  bandOf,
  categoryOf,
  dragBy,
  latencyBucket,
  roiGivenUp,
  summarizeDrag,
  type DragRow,
} from "@/lib/copyDrag";

const NOW = Date.UTC(2026, 7, 4, 14, 0, 0);

function row(o: Partial<DragRow> = {}): DragRow {
  return {
    walletEntryPrice: 0.62,
    ourEntryPrice: 0.67,
    walletAt: NOW,
    ourAt: NOW + 3 * 60_000,
    walletAddress: "0xabc",
    marketQuestion: "Team A vs. Team B",
    realizedPnl: 1,
    simulatedPositionSize: 10,
    ...o,
  };
}

describe("roiGivenUp", () => {
  it("filling worse than the wallet hands over part of the edge", () => {
    // 62¢ → 67¢: 1 − 0.62/0.67 ≈ 7.5% of expected ROI gone at entry.
    expect(roiGivenUp(0.62, 0.67)).toBeCloseTo(0.0746, 4);
  });

  it("filling at the same price gives up nothing", () => {
    expect(roiGivenUp(0.62, 0.62)).toBe(0);
  });

  it("filling BETTER than the wallet is negative drag — a gain, not a cost", () => {
    expect(roiGivenUp(0.67, 0.62)!).toBeLessThan(0);
  });

  it("precios imposibles devuelven null en vez de un número inventado", () => {
    expect(roiGivenUp(0, 0.5)).toBeNull();
    expect(roiGivenUp(0.5, 1)).toBeNull();
    expect(roiGivenUp(-0.2, 0.5)).toBeNull();
  });
});

describe("summarizeDrag", () => {
  it("resume céntimos, ROI cedido y latencia", () => {
    const s = summarizeDrag([row(), row({ walletEntryPrice: 0.5, ourEntryPrice: 0.52 })]);
    expect(s.n).toBe(2);
    expect(s.dragCents).toBeCloseTo((5 + 2) / 2, 6);
    expect(s.roiGivenUp).toBeGreaterThan(0);
    expect(s.latencyMinutes).toBeCloseTo(3, 6);
  });

  it("una lista vacía no revienta ni inventa", () => {
    const s = summarizeDrag([]);
    expect(s.n).toBe(0);
    expect(s.dragCents).toBe(0);
    expect(s.latencyMinutes).toBeNull();
    expect(s.realizedRoi).toBeNull();
  });

  it("sin marcas de tiempo no hay latencia — pero el arrastre sí se mide", () => {
    const s = summarizeDrag([row({ walletAt: null, ourAt: null })]);
    expect(s.n).toBe(1);
    expect(s.latencyMinutes).toBeNull();
    expect(s.dragCents).toBeCloseTo(5, 6);
  });

  it("ignora relojes corridos: nuestra copia no puede ser ANTERIOR a la billetera", () => {
    const s = summarizeDrag([row({ walletAt: NOW, ourAt: NOW - 60_000 })]);
    expect(s.latencyMinutes).toBeNull();
  });

  it("🩸 EL CASO QUE IMPORTA: el arrastre puede superar al ROI realizado", () => {
    // +2% realized on paper, but 7.5% of the edge was handed over at entry:
    // the cell only looks alive because the toll is invisible.
    const rows = Array.from({ length: 30 }, () => row({ realizedPnl: 0.2 }));
    const s = summarizeDrag(rows);
    expect(s.realizedRoi).toBeCloseTo(0.02, 6);
    expect(s.roiGivenUp).toBeGreaterThan(s.realizedRoi!);
  });
});

describe("latencyBucket", () => {
  it("clasifica por minutos entre la billetera y nosotros", () => {
    const at = (min: number) => latencyBucket(row({ walletAt: NOW, ourAt: NOW + min * 60_000 }));
    expect(at(0.5)).toBe("l00");
    expect(at(3)).toBe("l01");
    expect(at(10)).toBe("l05");
    expect(at(30)).toBe("l15");
    expect(at(180)).toBe("l60");
  });

  it("toda etiqueta de latencia existe", () => {
    for (const k of ["l00", "l01", "l05", "l15", "l60"]) expect(LATENCY_LABELS[k]).toBeTruthy();
  });

  it("sin fechas no hay bucket", () => {
    expect(latencyBucket(row({ walletAt: null }))).toBeNull();
  });
});

describe("dragBy", () => {
  it("agrupa y ordena por peaje: lo más caro primero", () => {
    const cheap = Array.from({ length: 10 }, () =>
      row({ walletAt: NOW, ourAt: NOW + 30_000, walletEntryPrice: 0.6, ourEntryPrice: 0.605 }),
    );
    const dear = Array.from({ length: 10 }, () =>
      row({ walletAt: NOW, ourAt: NOW + 40 * 60_000, walletEntryPrice: 0.6, ourEntryPrice: 0.75 }),
    );
    const groups = dragBy([...cheap, ...dear], latencyBucket, (k) => LATENCY_LABELS[k]);
    expect(groups[0].key).toBe("l15");
    expect(groups[0].stats.roiGivenUp).toBeGreaterThan(groups[1].stats.roiGivenUp);
  });

  it("descarta grupos con muestra insuficiente", () => {
    const groups = dragBy([row(), row()], latencyBucket, (k) => k, 5);
    expect(groups).toEqual([]);
  });

  it("agrupa por banda y por categoría con los mismos ejes de la matriz", () => {
    const rows = Array.from({ length: 6 }, () => row({ ourEntryPrice: 0.65, marketQuestion: "LoL: G2 vs T1" }));
    expect(dragBy(rows, bandOf)[0].key).toBe("p60");
    expect(dragBy(rows, categoryOf)[0].key).toBe("esports");
  });
});
