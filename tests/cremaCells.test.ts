import { describe, expect, it } from "vitest";
import { isCremaGoldCell } from "@/lib/cremaCells";

// Hour buckets (APP_TZ): madrugada 0-3, amanecer 4-7, mañana 8-11,
// mediodía 12-15, tarde 16-19, noche 20-23.

describe("isCremaGoldCell — esports rule (cheap ≤44¢ since 2026-07-20)", () => {
  it("CHEAP esports (≤44¢) is gold all day EXCEPT night", () => {
    for (const h of [2, 6, 9, 13, 18]) {
      expect(isCremaGoldCell("esports", h, 0.4).gold).toBe(true);
    }
  });

  /**
   * The 45-59¢ "coin flip" band is the trap both data sources agree on:
   * real money esports 3/7 (-19.6%) and deportes 3/6 (-13.2%); paper core
   * -7.6%. The first version of this rule (<60¢) swept it in with the gold.
   */
  it("the 45-59¢ COIN-FLIP band is NOT gold — the trap that cost real money", () => {
    for (const h of [2, 9, 13, 18]) {
      expect(isCremaGoldCell("esports", h, 0.45).gold).toBe(false);
      expect(isCremaGoldCell("esports", h, 0.55).gold).toBe(false);
      expect(isCremaGoldCell("deportes", h, 0.5).gold).toBe(false);
    }
  });

  it("the cheap boundary is 44¢/45¢, not 59¢/60¢", () => {
    expect(isCremaGoldCell("esports", 9, 0.44).gold).toBe(true);
    expect(isCremaGoldCell("esports", 13, 0.449).gold).toBe(true);
    expect(isCremaGoldCell("esports", 13, 0.45).gold).toBe(false);
  });

  it("esports at night (20-23) is NOT gold — the one slot it turns red", () => {
    expect(isCremaGoldCell("esports", 21, 0.7).gold).toBe(false);
    expect(isCremaGoldCell("esports", 23, 0.4).gold).toBe(false);
  });

  it("keeps esports at MIDDAY — midday is bad for sports, not for esports", () => {
    expect(isCremaGoldCell("esports", 13, 0.3).gold).toBe(true);
  });

  /**
   * The half of the original rule that FAILED its forward-test: expensive
   * esports is red in every window (60-74¢ -3.6%, 75-89¢ -10% at 7d). It no
   * longer qualifies via the esports rule — only via the band+window rule.
   */
  it("EXPENSIVE esports outside the green windows is NOT gold", () => {
    expect(isCremaGoldCell("esports", 13, 0.7).gold).toBe(false); // midday, 70¢
    expect(isCremaGoldCell("esports", 6, 0.85).gold).toBe(false); // amanecer, 85¢
  });

  it("expensive esports IN a green window still enters via the band rule", () => {
    expect(isCremaGoldCell("esports", 9, 0.7).gold).toBe(true); // morning + 60-89¢
  });
});

describe("isCremaGoldCell — high-band window rule", () => {
  it("deportes 60-89¢ in the morning is gold", () => {
    expect(isCremaGoldCell("deportes", 9, 0.65).gold).toBe(true);
    expect(isCremaGoldCell("deportes", 11, 0.88).gold).toBe(true);
  });

  it("deportes 60-89¢ in the tarde is gold", () => {
    expect(isCremaGoldCell("deportes", 17, 0.7).gold).toBe(true);
  });

  it("deportes high band OUTSIDE the two green windows is NOT gold", () => {
    expect(isCremaGoldCell("deportes", 2, 0.7).gold).toBe(false); // madrugada
    expect(isCremaGoldCell("deportes", 6, 0.7).gold).toBe(false); // amanecer
    expect(isCremaGoldCell("deportes", 13, 0.7).gold).toBe(false); // mediodía — sports bleed
    expect(isCremaGoldCell("deportes", 21, 0.7).gold).toBe(false); // noche
  });

  it("morning but WRONG band is not gold — the band is half the rule", () => {
    expect(isCremaGoldCell("deportes", 9, 0.45).gold).toBe(false); // coin-flip band
    expect(isCremaGoldCell("deportes", 9, 0.95).gold).toBe(false); // ≥90¢ almost-done
    expect(isCremaGoldCell("deportes", 9, 0.25).gold).toBe(false); // longshot
  });

  it("band boundaries: 60¢ inclusive, 90¢ exclusive", () => {
    expect(isCremaGoldCell("deportes", 9, 0.6).gold).toBe(true);
    expect(isCremaGoldCell("deportes", 9, 0.9).gold).toBe(false);
    expect(isCremaGoldCell("deportes", 9, 0.899).gold).toBe(true);
  });
});

describe("isCremaGoldCell — hard excludes", () => {
  it("clima is never gold, even in a would-be-gold window", () => {
    expect(isCremaGoldCell("clima", 9, 0.7).gold).toBe(false);
  });

  it("cripto is never gold, even esports-like all-day", () => {
    expect(isCremaGoldCell("cripto", 9, 0.7).gold).toBe(false);
  });

  it("the exclude wins over the esports rule too (defensive — a market can't be both, but the gate must be order-safe)", () => {
    // clima at a non-night hour must still be excluded.
    expect(isCremaGoldCell("clima", 10, 0.4).gold).toBe(false);
  });
});

describe("isCremaGoldCell — everything else is left to the arms", () => {
  it("politica/otros only qualify via the high-band window rule", () => {
    expect(isCremaGoldCell("politica", 13, 0.7).gold).toBe(false); // midday
    expect(isCremaGoldCell("otros", 9, 0.7).gold).toBe(true); // morning high band
    expect(isCremaGoldCell("otros", 9, 0.3).gold).toBe(false); // morning low band
  });

  it("every verdict carries a human-readable reason", () => {
    expect(isCremaGoldCell("esports", 9, 0.4).reason).toMatch(/esports/);
    expect(isCremaGoldCell("deportes", 9, 0.7).reason).toMatch(/oro|Mañana/);
    expect(isCremaGoldCell("clima", 9, 0.7).reason).toMatch(/excluida/);
  });
});
