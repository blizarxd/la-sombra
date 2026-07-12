import { describe, expect, it } from "vitest";
import { decideWalletBench } from "@/lib/scoring/walletScoring";

describe("decideWalletBench (sticky bench for bleeding wallets)", () => {
  it("does nothing without enough settled copies", () => {
    expect(decideWalletBench({ status: "track", benched: false }, { pnl: -50, n: 2 })).toBeNull();
  });

  it("does nothing when paper pnl is not bleeding", () => {
    expect(decideWalletBench({ status: "track", benched: false }, { pnl: -3, n: 10 })).toBeNull();
  });

  it("soft bleed (-$5..-$10) downgrades track -> watch, not benched", () => {
    expect(decideWalletBench({ status: "track", benched: false }, { pnl: -7, n: 5 })).toEqual({
      status: "watch",
      benched: false,
    });
  });

  it("hard bleed (< -$10) downgrades to ignore AND benches", () => {
    expect(decideWalletBench({ status: "track", benched: false }, { pnl: -25, n: 8 })).toEqual({
      status: "ignore",
      benched: true,
    });
  });

  it("backfills an already-ignored bleeder that was never benched", () => {
    // exactly the 0xa0f21e case: status ignore, benched false, still bleeding
    expect(decideWalletBench({ status: "ignore", benched: false }, { pnl: -104, n: 27 })).toEqual({
      status: "ignore",
      benched: true,
    });
  });

  it("is a no-op once already ignored AND benched", () => {
    expect(decideWalletBench({ status: "ignore", benched: true }, { pnl: -104, n: 27 })).toBeNull();
  });

  it("never re-opens a benched wallet, even on a soft-bleed evaluation", () => {
    // benched wallet with a soft-bleed number stays ignored, not promoted to watch
    expect(decideWalletBench({ status: "ignore", benched: true }, { pnl: -7, n: 5 })).toBeNull();
  });
});
