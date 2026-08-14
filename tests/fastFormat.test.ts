import { describe, expect, it } from "vitest";
import { isFastFormatMarket } from "@/lib/fastFormat";

describe("isFastFormatMarket", () => {
  it("matches a single map/game inside an esports series", () => {
    expect(isFastFormatMarket("LoL: Shifters vs SK Gaming - Game 2 Winner")).toBe(true);
    expect(isFastFormatMarket("Counter-Strike: FUT Esports vs MOUZ (BO3) - Map 1 Winner")).toBe(true);
    expect(isFastFormatMarket("Valorant: Team Envy vs M80 - Map 1 Winner")).toBe(true);
  });

  it("does NOT match the overall series winner — that takes hours, not the map inside it", () => {
    expect(isFastFormatMarket("Dota 2: Nigma Galaxy vs Vici Gaming (BO3) - The International Group Stage")).toBe(
      false,
    );
    expect(
      isFastFormatMarket("LoL: BNK FearX Youth vs Kiwoom DRX Challengers (BO3) - LCK Challengers League Rounds 3-4"),
    ).toBe(false);
  });

  it("matches split-period sports props (half, quarter, period)", () => {
    expect(isFastFormatMarket("Draw at halftime?")).toBe(true);
    expect(isFastFormatMarket("AS Saint-Étienne vs. Clermont Foot 63: 1st half winner")).toBe(true);
    expect(isFastFormatMarket("Lakers vs Celtics - Q1 winner")).toBe(true);
  });

  it("does NOT match a full-match outcome — same reasoning as the series case", () => {
    expect(isFastFormatMarket("Kashima Antlers vs. Nagoya Grampus: Both Teams to Score")).toBe(false);
    expect(isFastFormatMarket("St. Louis Cardinals vs. Chicago Cubs")).toBe(false);
    expect(isFastFormatMarket("Cincinnati Open: Elvina Kalieva vs Oleksandra Oliynykova")).toBe(false);
  });

  it("handles missing questions without throwing", () => {
    expect(isFastFormatMarket(null)).toBe(false);
    expect(isFastFormatMarket(undefined)).toBe(false);
    expect(isFastFormatMarket("")).toBe(false);
  });

  it("classifies a combo by its first leg, same convention as categorizeMarket", () => {
    expect(isFastFormatMarket("LoL: A vs B - Game 1 Winner AND Bitcoin above $120k")).toBe(true);
  });
});
