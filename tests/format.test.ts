import { describe, expect, it } from "vitest";
import { dayKeyTz, hourInAppTz } from "@/lib/format";

// APP_TZ = America/Caracas = UTC-4, no daylight saving (fixed offset).
describe("hourInAppTz (drives the daily-cycle 08:00 gate)", () => {
  it("converts UTC midnight to 20:00 the previous Caracas day", () => {
    expect(hourInAppTz(new Date("2026-07-14T00:00:00Z"))).toBe(20);
  });

  it("converts UTC 12:00 to 08:00 Caracas — the daily-cycle cut hour", () => {
    expect(hourInAppTz(new Date("2026-07-14T12:00:00Z"))).toBe(8);
  });

  it("stays within 08:xx for the whole 08:00 UTC-4 hour", () => {
    expect(hourInAppTz(new Date("2026-07-14T12:00:00Z"))).toBe(8);
    expect(hourInAppTz(new Date("2026-07-14T12:59:00Z"))).toBe(8);
    expect(hourInAppTz(new Date("2026-07-14T13:00:00Z"))).toBe(9); // just past the window
  });

  it("agrees with dayKeyTz on which Caracas day a near-midnight-UTC timestamp falls on", () => {
    // 2026-07-15T02:00:00Z = 2026-07-14 22:00 Caracas — still the 14th locally.
    const t = new Date("2026-07-15T02:00:00Z");
    expect(dayKeyTz(t)).toBe("2026-07-14");
    expect(hourInAppTz(t)).toBe(22);
  });
});
