import { describe, expect, it } from "vitest";
import { effectiveMinEntryPrice } from "@/lib/categoryEntryBand";

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
