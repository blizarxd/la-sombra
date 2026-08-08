import { describe, expect, it } from "vitest";
import {
  MAX_PICK_SPREAD,
  MIN_PICK_SCORE,
  choosePick,
  byCalendarDay,
  choosePicks,
  comboMath,
  nextDay,
  isEligible,
  pickPnl,
  spreadOf,
  summarizeRecord,
  type DayRow,
  type PickCandidate,
  type PickRow,
} from "@/lib/dailyPick";

/**
 * These tests exist to keep the record HONEST, not to keep it flattering. The
 * failure mode of every tipster is a record that cannot be falsified: picks
 * priced at the mid, bad days quietly dropped, a hit rate quoted without the
 * price it was won at. Each of those has a test here.
 */

function cand(o: Partial<PickCandidate> = {}): PickCandidate {
  return {
    marketId: "0xm1",
    tokenId: "t1",
    marketQuestion: "Team A vs Team B",
    outcome: "Yes",
    walletAddress: "0xabc",
    category: "deportes",
    entryPrice: 0.65,
    bestBid: 0.63,
    copyScore: 75,
    confidence: 0.7,
    cellId: "cat-band:deportes:p60",
    cellLabel: "⚽ Deportes × 60–74¢",
    cellFloor: 0.04,
    cellRealN: 80,
    ...o,
  };
}

describe("elegibilidad", () => {
  it("un candidato normal de celda de oro es publicable", () => {
    expect(isEligible(cand())).toBe(true);
  });

  it("sin celda de oro detrás NO se publica — no inventamos convicción", () => {
    expect(isEligible(cand({ cellId: null }))).toBe(false);
  });

  it("por debajo del puntaje mínimo no se publica", () => {
    expect(isEligible(cand({ copyScore: MIN_PICK_SCORE - 1 }))).toBe(false);
  });

  it("un spread demasiado ancho descalifica: entrar ahí ya es perder", () => {
    expect(isEligible(cand({ entryPrice: 0.65, bestBid: 0.65 - (MAX_PICK_SPREAD + 0.01) }))).toBe(false);
  });

  it("precios imposibles fuera", () => {
    expect(isEligible(cand({ entryPrice: 0 }))).toBe(false);
    expect(isEligible(cand({ entryPrice: 1 }))).toBe(false);
  });

  it("calcula el spread pagado", () => {
    expect(spreadOf(cand({ entryPrice: 0.65, bestBid: 0.6 }))).toBeCloseTo(0.05, 6);
    expect(spreadOf(cand({ bestBid: null }))).toBeNull();
  });
});

describe("choosePick", () => {
  it("🔒 un día sin nada bueno NO produce pick", () => {
    // Forcing a pick every day is how a record fills up with coin flips.
    expect(choosePick([cand({ copyScore: 10 }), cand({ cellId: null })])).toBeNull();
    expect(choosePick([])).toBeNull();
  });

  it("elige por el PISO de la celda, no por el puntaje de la señal", () => {
    const hypeado = cand({ marketId: "0xhype", copyScore: 99, cellFloor: -0.02, cellId: "c1" });
    const probado = cand({ marketId: "0xsolido", copyScore: 65, cellFloor: 0.06, cellId: "c2" });
    expect(choosePick([hypeado, probado])!.candidate.marketId).toBe("0xsolido");
  });

  it("a igual piso, gana la celda con más copias reales detrás", () => {
    const poco = cand({ marketId: "0xpoco", cellRealN: 5, cellId: "c1" });
    const mucho = cand({ marketId: "0xmucho", cellRealN: 200, cellId: "c2" });
    expect(choosePick([poco, mucho])!.candidate.marketId).toBe("0xmucho");
  });

  it("es determinista: el mismo día siempre da el mismo pick", () => {
    const set = [cand({ marketId: "0xb" }), cand({ marketId: "0xa" })];
    const a = choosePick(set)!.candidate.marketId;
    const b = choosePick([...set].reverse())!.candidate.marketId;
    expect(a).toBe(b);
  });

  it("el razonamiento dice el precio, el spread y cuántos candidatos había", () => {
    const r = choosePick([cand(), cand({ marketId: "0xm2" })])!.reasoning;
    expect(r).toMatch(/65¢/);
    expect(r).toMatch(/spread/);
    expect(r).toMatch(/2 candidatos/);
  });
});

describe("pickPnl", () => {
  it("ganar a 65¢ con $10 devuelve algo más de $5", () => {
    expect(pickPnl(0.65, true)).toBeCloseTo(5.38, 2);
  });

  it("perder siempre cuesta la unidad entera", () => {
    expect(pickPnl(0.65, false)).toBe(-10);
    expect(pickPnl(0.2, false)).toBe(-10);
  });

  it("un tiro largo paga mucho más", () => {
    expect(pickPnl(0.2, true)!).toBeGreaterThan(pickPnl(0.8, true)!);
  });

  it("precio imposible no inventa resultado", () => {
    expect(pickPnl(0, true)).toBeNull();
    expect(pickPnl(1, true)).toBeNull();
  });
});

describe("summarizeRecord — el marcador público", () => {
  const row = (o: Partial<PickRow> = {}): PickRow => ({
    pickDate: "2026-08-06",
    status: "ganado",
    entryPrice: 0.65,
    pnlPer10: 5.38,
    ...o,
  });

  it("cuenta abiertos y liquidados por separado", () => {
    const r = summarizeRecord([row(), row({ status: "perdido", pnlPer10: -10 }), row({ status: "abierto", pnlPer10: null })]);
    expect(r.total).toBe(3);
    expect(r.settled).toBe(2);
    expect(r.open).toBe(1);
    expect(r.won).toBe(1);
    expect(r.lost).toBe(1);
  });

  it("🔒 EL NÚMERO QUE IMPORTA: 60% de acierto a 80¢ es un NEGOCIO PERDEDOR", () => {
    // Six winners in ten looks great in an ad. At 80¢ you needed 80%.
    const rows = Array.from({ length: 10 }, (_, i) =>
      i < 6
        ? row({ pickDate: `2026-08-${10 + i}`, entryPrice: 0.8, status: "ganado", pnlPer10: 2.5 })
        : row({ pickDate: `2026-08-${10 + i}`, entryPrice: 0.8, status: "perdido", pnlPer10: -10 }),
    );
    const r = summarizeRecord(rows);
    expect(r.winRate).toBeCloseTo(0.6, 6);
    expect(r.breakEvenRate).toBeCloseTo(0.8, 6); // needed 80% just to stand still
    expect(r.winRate!).toBeLessThan(r.breakEvenRate!);
    expect(r.totalPnl).toBeLessThan(0); // and indeed it lost money
  });

  it("la tasa de acierto trae su piso: 3 de 3 no es 100% de confianza", () => {
    const r = summarizeRecord([
      row({ pickDate: "2026-08-01" }),
      row({ pickDate: "2026-08-02" }),
      row({ pickDate: "2026-08-03" }),
    ]);
    expect(r.winRate).toBe(1);
    expect(r.winRateFloor!).toBeLessThan(0.8);
  });

  it("mide la peor racha de derrotas — lo que un seguidor de verdad siente", () => {
    const r = summarizeRecord([
      row({ pickDate: "2026-08-01", status: "perdido", pnlPer10: -10 }),
      row({ pickDate: "2026-08-02", status: "perdido", pnlPer10: -10 }),
      row({ pickDate: "2026-08-03", status: "perdido", pnlPer10: -10 }),
      row({ pickDate: "2026-08-04", status: "ganado" }),
      row({ pickDate: "2026-08-05", status: "perdido", pnlPer10: -10 }),
    ]);
    expect(r.worstStreak).toBe(3);
  });

  it("un abierto NO corta la racha: todavía no se sabe", () => {
    const r = summarizeRecord([
      row({ pickDate: "2026-08-01", status: "perdido", pnlPer10: -10 }),
      row({ pickDate: "2026-08-02", status: "abierto", pnlPer10: null }),
      row({ pickDate: "2026-08-03", status: "perdido", pnlPer10: -10 }),
    ]);
    expect(r.worstStreak).toBe(2);
  });

  it("sin picks liquidados no inventa tasas", () => {
    const r = summarizeRecord([row({ status: "abierto", pnlPer10: null })]);
    expect(r.winRate).toBeNull();
    expect(r.roiFloor).toBeNull();
    expect(r.totalPnl).toBe(0);
  });

  it("el ROI trae piso corregido, siempre por debajo del titular", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ pickDate: `2026-08-${(i % 28) + 1}`, status: i % 3 === 0 ? "perdido" : "ganado", pnlPer10: i % 3 === 0 ? -10 : 5.38 }),
    );
    const r = summarizeRecord(rows);
    expect(r.roiFloor!).toBeLessThan(r.roi);
  });
});

describe("choosePicks — la lista corta", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      cand({ marketId: `0xm${i}`, cellId: `c${i}`, cellFloor: 0.1 - i * 0.01, cellRealN: 100 - i }),
    );

  it("publica hasta 4: el pick del día y 3 alternativas", () => {
    expect(choosePicks(many(9))).toHaveLength(4);
  });

  it("el rango sigue el mismo criterio: piso de celda primero", () => {
    const picks = choosePicks(many(6));
    const floors = picks.map((p) => p.candidate.cellFloor!);
    expect([...floors]).toEqual([...floors].sort((a, b) => b - a));
  });

  it("el primero se etiqueta PICK DEL DÍA y los demás como alternativa", () => {
    const picks = choosePicks(many(4));
    expect(picks[0].reasoning).toMatch(/PICK DEL DÍA/);
    expect(picks[1].reasoning).toMatch(/alternativa #2/);
    expect(picks[3].reasoning).toMatch(/alternativa #4/);
  });

  it("si solo hay 2 candidatos buenos, publica 2 — no rellena", () => {
    expect(choosePicks([...many(2), cand({ marketId: "0xbad", copyScore: 5 })])).toHaveLength(2);
  });

  it("sin nada elegible devuelve lista vacía", () => {
    expect(choosePicks([cand({ cellId: null })])).toEqual([]);
  });

  it("choosePick sigue devolviendo el primero de la lista", () => {
    const all = choosePicks(many(5));
    expect(choosePick(many(5))!.candidate.marketId).toBe(all[0].candidate.marketId);
  });
});

describe("comboMath — la aritmética de juntar dos", () => {
  it("el precio combinado es el producto, y el multiplicador su inverso", () => {
    const m = comboMath({ entryPrice: 0.65, bestBid: 0.63 }, { entryPrice: 0.7, bestBid: 0.68 });
    expect(m.combinedPrice).toBeCloseTo(0.455, 6);
    expect(m.multiple).toBeCloseTo(1 / 0.455, 4);
  });

  it("🔒 EL NÚMERO CLAVE: el peaje se paga DOS veces y la EV sale negativa", () => {
    const m = comboMath({ entryPrice: 0.65, bestBid: 0.61 }, { entryPrice: 0.7, bestBid: 0.66 });
    expect(m.spreadDrag!).toBeGreaterThan(0);
    expect(m.evPer10!).toBeLessThan(0); // priced off the mid, a fair parlay still loses the spread
  });

  it("más spread por pata ⇒ más arrastre y peor EV", () => {
    const barato = comboMath({ entryPrice: 0.65, bestBid: 0.64 }, { entryPrice: 0.7, bestBid: 0.69 });
    const caro = comboMath({ entryPrice: 0.65, bestBid: 0.59 }, { entryPrice: 0.7, bestBid: 0.64 });
    expect(caro.spreadDrag!).toBeGreaterThan(barato.spreadDrag!);
    expect(caro.evPer10!).toBeLessThan(barato.evPer10!);
  });

  it("acertar las dos es MENOS probable que cualquiera por separado", () => {
    const m = comboMath({ entryPrice: 0.65, bestBid: 0.63 }, { entryPrice: 0.7, bestBid: 0.68 });
    expect(m.bothLandRate).toBeLessThan(0.65);
    expect(m.bothLandRate).toBeLessThan(0.7);
  });

  it("sin bestBid no inventa el coste del spread", () => {
    const m = comboMath({ entryPrice: 0.65, bestBid: null }, { entryPrice: 0.7, bestBid: 0.68 });
    expect(m.spreadCents).toBeNull();
    expect(m.evPer10).toBeNull();
    expect(m.combinedPrice).toBeCloseTo(0.455, 6); // the price still computes
  });
});

describe("byCalendarDay — el día a día", () => {
  const d = (o: Partial<DayRow> = {}): DayRow => ({
    pickDate: "2026-08-07",
    rank: 1,
    status: "ganado",
    entryPrice: 0.6,
    pnlPer10: 6.67,
    ...o,
  });

  it("una fila por día, la más vieja primero", () => {
    const days = byCalendarDay([d({ pickDate: "2026-08-09" }), d({ pickDate: "2026-08-07" })]);
    expect(days.map((x) => x.date)).toEqual(["2026-08-07", "2026-08-08", "2026-08-09"]);
  });

  it("🔒 un día SIN pick aparece igual: saltárselo escondería con qué frecuencia dispara", () => {
    const days = byCalendarDay([d({ pickDate: "2026-08-07" }), d({ pickDate: "2026-08-10" })]);
    const gap = days.filter((x) => x.noPick).map((x) => x.date);
    expect(gap).toEqual(["2026-08-08", "2026-08-09"]);
    expect(days.find((x) => x.date === "2026-08-08")!.status).toBe("sin-pick");
  });

  it("separa el pick oficial de sus alternativas", () => {
    const days = byCalendarDay([d(), d({ rank: 2, status: "perdido", pnlPer10: -10 }), d({ rank: 3 })]);
    expect(days[0].main!.rank).toBe(1);
    expect(days[0].alternates.map((a) => a.rank)).toEqual([2, 3]);
  });

  it("el acumulado SOLO cuenta el pick oficial, nunca las alternativas", () => {
    // Otherwise the record silently becomes "at least one of our four won".
    const days = byCalendarDay([
      d({ pickDate: "2026-08-07", rank: 1, pnlPer10: -10, status: "perdido" }),
      d({ pickDate: "2026-08-07", rank: 2, pnlPer10: 50, status: "ganado" }),
    ]);
    expect(days[0].cumulativePnl).toBe(-10);
  });

  it("el acumulado se arrastra y los días sin pick no lo mueven", () => {
    const days = byCalendarDay([
      d({ pickDate: "2026-08-07", pnlPer10: 5 }),
      d({ pickDate: "2026-08-10", pnlPer10: -10 }),
    ]);
    expect(days.map((x) => x.cumulativePnl)).toEqual([5, 5, 5, -5]);
  });

  it("un abierto no suma todavía", () => {
    const days = byCalendarDay([d({ status: "abierto", pnlPer10: null })]);
    expect(days[0].cumulativePnl).toBe(0);
    expect(days[0].status).toBe("abierto");
  });

  it("extiende hasta HOY aunque hoy no haya pick", () => {
    const days = byCalendarDay([d({ pickDate: "2026-08-07" })], "2026-08-09");
    expect(days[days.length - 1].date).toBe("2026-08-09");
    expect(days[days.length - 1].noPick).toBe(true);
  });

  it("sin picks no inventa calendario", () => {
    expect(byCalendarDay([])).toEqual([]);
  });

  it("nextDay cruza mes y año bien", () => {
    expect(nextDay("2026-08-31")).toBe("2026-09-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29"); // leap year
  });
});
