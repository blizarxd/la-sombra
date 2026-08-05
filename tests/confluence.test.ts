import { describe, expect, it } from "vitest";
import {
  CONFLUENCE_WINDOW_MS,
  confluenceIndex,
  findClusters,
  positionKey,
  type ConfluenceTrade,
} from "@/lib/confluence";

const NOW = Date.UTC(2026, 7, 4, 14, 0, 0);
const MIN = 60_000;

let seq = 0;
function t(o: Partial<ConfluenceTrade> = {}): ConfluenceTrade {
  return {
    id: `o${seq++}`,
    walletAddress: "0xaaa",
    marketId: "0xmarket1",
    outcome: "Yes",
    side: "BUY",
    timestamp: NOW,
    ...o,
  };
}

describe("positionKey", () => {
  it("mercado + resultado, insensible a mayúsculas", () => {
    expect(positionKey({ marketId: "m", outcome: "Yes" })).toBe(positionKey({ marketId: "m", outcome: "YES" }));
  });

  it("distingue lados opuestos del mismo mercado", () => {
    expect(positionKey({ marketId: "m", outcome: "Yes" })).not.toBe(positionKey({ marketId: "m", outcome: "No" }));
  });
});

describe("confluenceIndex", () => {
  it("cuenta las billeteras distintas que ya estaban en la misma posición", () => {
    const a = t({ walletAddress: "0xa", timestamp: NOW });
    const b = t({ walletAddress: "0xb", timestamp: NOW + 5 * MIN });
    const c = t({ walletAddress: "0xc", timestamp: NOW + 10 * MIN });
    const idx = confluenceIndex([a, b, c]);
    expect(idx.get(a.id)).toBe(0); // first one has nobody to confirm it
    expect(idx.get(b.id)).toBe(1);
    expect(idx.get(c.id)).toBe(2);
  });

  it("🔒 UNA billetera partiendo la orden en ocho NO es una multitud", () => {
    const fills = Array.from({ length: 8 }, (_, i) => t({ walletAddress: "0xsame", timestamp: NOW + i * MIN }));
    const idx = confluenceIndex(fills);
    expect([...idx.values()].every((v) => v === 0)).toBe(true);
  });

  it("lados opuestos son desacuerdo, no confirmación", () => {
    const yes = t({ walletAddress: "0xa", outcome: "Yes", timestamp: NOW });
    const no = t({ walletAddress: "0xb", outcome: "No", timestamp: NOW + MIN });
    const idx = confluenceIndex([yes, no]);
    expect(idx.get(no.id)).toBe(0);
  });

  it("mercados distintos no se confirman entre sí", () => {
    const a = t({ walletAddress: "0xa", marketId: "m1", timestamp: NOW });
    const b = t({ walletAddress: "0xb", marketId: "m2", timestamp: NOW + MIN });
    expect(confluenceIndex([a, b]).get(b.id)).toBe(0);
  });

  it("solo mira HACIA ATRÁS — al decidir no se puede leer el futuro", () => {
    const first = t({ walletAddress: "0xa", timestamp: NOW });
    const later = t({ walletAddress: "0xb", timestamp: NOW + 2 * MIN });
    const idx = confluenceIndex([first, later]);
    expect(idx.get(first.id)).toBe(0);
    expect(idx.get(later.id)).toBe(1);
  });

  it("fuera de la ventana ya no confirma", () => {
    const old = t({ walletAddress: "0xa", timestamp: NOW });
    const late = t({ walletAddress: "0xb", timestamp: NOW + CONFLUENCE_WINDOW_MS + MIN });
    expect(confluenceIndex([old, late]).get(late.id)).toBe(0);
  });

  it("las ventas no cuentan como confluencia de compra", () => {
    const sell = t({ walletAddress: "0xa", side: "SELL", timestamp: NOW });
    const buy = t({ walletAddress: "0xb", timestamp: NOW + MIN });
    expect(confluenceIndex([sell, buy]).get(buy.id)).toBe(0);
  });

  it("acepta la lista vacía", () => {
    expect(confluenceIndex([]).size).toBe(0);
  });
});

describe("findClusters", () => {
  it("encuentra la posición donde dos billeteras coincidieron", () => {
    const clusters = findClusters([
      t({ walletAddress: "0xa", timestamp: NOW }),
      t({ walletAddress: "0xb", timestamp: NOW + 3 * MIN }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].wallets.sort()).toEqual(["0xa", "0xb"]);
  });

  it("una sola billetera nunca forma racimo", () => {
    expect(findClusters([t({ walletAddress: "0xa" }), t({ walletAddress: "0xa", timestamp: NOW + MIN })])).toEqual([]);
  });

  it("no emite un racimo por trade: tres billeteras son UN racimo de tres", () => {
    const clusters = findClusters([
      t({ walletAddress: "0xa", timestamp: NOW }),
      t({ walletAddress: "0xb", timestamp: NOW + MIN }),
      t({ walletAddress: "0xc", timestamp: NOW + 2 * MIN }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].wallets).toHaveLength(3);
  });

  it("se puede exigir más consenso", () => {
    const trades = [
      t({ walletAddress: "0xa", timestamp: NOW }),
      t({ walletAddress: "0xb", timestamp: NOW + MIN }),
    ];
    expect(findClusters(trades, CONFLUENCE_WINDOW_MS, 3)).toEqual([]);
  });

  it("ordena por lo más reciente primero", () => {
    const old = [
      t({ marketId: "m1", walletAddress: "0xa", timestamp: NOW }),
      t({ marketId: "m1", walletAddress: "0xb", timestamp: NOW + MIN }),
    ];
    const fresh = [
      t({ marketId: "m2", walletAddress: "0xc", timestamp: NOW + 100 * MIN }),
      t({ marketId: "m2", walletAddress: "0xd", timestamp: NOW + 101 * MIN }),
    ];
    expect(findClusters([...old, ...fresh])[0].marketId).toBe("m2");
  });
});
