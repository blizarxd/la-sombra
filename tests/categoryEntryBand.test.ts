import { describe, expect, it } from "vitest";
import { effectiveMinEntryPrice, isCategoryExcluded } from "@/lib/categoryEntryBand";

describe("effectiveMinEntryPrice", () => {
  it("tightens core's floor for deportes to the matrix-backed 0.60", () => {
    expect(effectiveMinEntryPrice("core", "deportes", 0.1)).toBe(0.6);
  });

  it("never LOOSENS the floor — if the global floor is already stricter, keep it", () => {
    expect(effectiveMinEntryPrice("core", "deportes", 0.7)).toBe(0.7);
  });

  it("leaves esports and other categories at the global floor — evidence too thin in core", () => {
    expect(effectiveMinEntryPrice("core", "esports", 0.1)).toBe(0.1);
    expect(effectiveMinEntryPrice("core", "otros", 0.1)).toBe(0.1);
  });

  it("has no override for other scopes — live/trade/crypto stay untouched", () => {
    expect(effectiveMinEntryPrice("live", "deportes", 0.26)).toBe(0.26);
    expect(effectiveMinEntryPrice("trade", "deportes", 0.1)).toBe(0.1);
    expect(effectiveMinEntryPrice("crypto", "cripto", 0.55)).toBe(0.55);
  });
});

describe("isCategoryExcluded", () => {
  it("excludes weather markets from the live book (13% win, ROI -55%)", () => {
    expect(isCategoryExcluded("live", "clima")).toBe(true);
  });

  it("keeps live's winning categories — esports and deportes are NOT excluded", () => {
    expect(isCategoryExcluded("live", "esports")).toBe(false);
    expect(isCategoryExcluded("live", "deportes")).toBe(false);
  });

  it("does not exclude clima from other books — the finding is live-specific", () => {
    expect(isCategoryExcluded("core", "clima")).toBe(false);
    expect(isCategoryExcluded("trade", "clima")).toBe(false);
  });
});
