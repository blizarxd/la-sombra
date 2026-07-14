import { describe, expect, it } from "vitest";
import { categorizeMarket } from "@/lib/category";

describe("categorizeMarket (derived from question text — API category is ~98% null)", () => {
  it("classifies real sports questions (from the live /paper table)", () => {
    expect(categorizeMarket("Athens Open: Sapfo Sakellaridi vs Miriana Tona")).toBe("deportes");
    expect(categorizeMarket("Cordenons: Maxim Mrva vs Carlo Alberto Caniato")).toBe("deportes");
    expect(categorizeMarket("Croatia Open: Federico Agustin Gomez vs Niels McDonald")).toBe("deportes");
    expect(categorizeMarket("Philadelphia Phillies vs. Detroit Tigers")).toBe("deportes");
    expect(categorizeMarket("Spread: Ferencvárosi TC (-1.5)")).toBe("deportes");
    expect(categorizeMarket("Will Chicago Fire FC win on 2026-07-22?")).toBe("deportes");
  });

  it("classifies esports before sports even though esports also says 'vs'", () => {
    expect(categorizeMarket("Dota 2: Vici Gaming vs PlayTime (BO3) - Esports World Cup Survival")).toBe("esports");
    expect(categorizeMarket("LoL: VfB eSports vs BIG (BO1) - Prime League")).toBe("esports");
  });

  it("classifies crypto markets", () => {
    expect(categorizeMarket("Bitcoin Up or Down - July 13, 6PM ET")).toBe("cripto");
    expect(categorizeMarket("Ethereum Up or Down - July 13, 6:15PM-6:30PM ET")).toBe("cripto");
    expect(categorizeMarket("Will BTC close above $120k this week?")).toBe("cripto");
    expect(categorizeMarket("Will ETH flip $4k before Friday?")).toBe("cripto");
  });

  it("classifies economy / finance", () => {
    expect(categorizeMarket("Will the Fed cut rates in September?")).toBe("economia");
    expect(categorizeMarket("Will CPI come in above 3% in August?")).toBe("economia");
  });

  it("classifies politics / geopolitics", () => {
    expect(categorizeMarket("Will Iran announce withdrawal from MOU negotiations by July 17?")).toBe("politica");
    expect(categorizeMarket("Will there be a ceasefire in Ukraine by August?")).toBe("politica");
    expect(categorizeMarket("2028 Presidential Election Winner")).toBe("politica");
  });

  it("classifies weather", () => {
    expect(categorizeMarket("Will NYC temperature exceed 100 degrees this week?")).toBe("clima");
  });

  it("inherits the FIRST leg's category for combos", () => {
    expect(
      categorizeMarket("Pozoblanco: Chris Rodesch vs Mert Alkaya AND Pozoblanco: Paul Inchauspe vs Hamish Stewart"),
    ).toBe("deportes");
  });

  it("falls back to 'otros' for unknowns and empty input", () => {
    expect(categorizeMarket("Something completely unrelated happening")).toBe("otros");
    expect(categorizeMarket(null)).toBe("otros");
    expect(categorizeMarket("")).toBe("otros");
  });
});
