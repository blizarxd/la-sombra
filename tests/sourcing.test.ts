import { describe, expect, it } from "vitest";
import { mergeSource, selectSourcableWallets } from "@/lib/sourcing";
import type { WalletTrade } from "@/lib/adapters/types";

function trade(address: string, side: "BUY" | "SELL"): WalletTrade {
  return {
    walletAddress: address,
    marketId: "m",
    conditionId: "c",
    tokenId: "t",
    marketQuestion: null,
    marketCategory: null,
    outcome: "Yes",
    side,
    price: 0.5,
    sizeUsd: 10,
    timestampMs: 1,
    transactionHash: null,
    raw: {},
  };
}

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("mergeSource", () => {
  it("seeds from empty/null", () => {
    expect(mergeSource(null, "crypto-market")).toBe("crypto-market");
    expect(mergeSource("", "fast-market")).toBe("fast-market");
  });

  it("appends without duplicating", () => {
    expect(mergeSource("crypto-market", "fast-market")).toBe("crypto-market,fast-market");
    expect(mergeSource("crypto-market", "crypto-market")).toBe("crypto-market");
  });
});

describe("selectSourcableWallets", () => {
  it("collects all distinct real wallets by default", () => {
    const got = selectSourcableWallets([trade(A, "BUY"), trade(A, "SELL"), trade(B, "BUY")]);
    expect(got.sort()).toEqual([A, B].sort());
  });

  it("sellersOnly keeps only wallets seen selling (scalper signal)", () => {
    const got = selectSourcableWallets([trade(A, "BUY"), trade(B, "SELL")], { sellersOnly: true });
    expect(got).toEqual([B]);
  });

  it("skips non-hex / demo addresses", () => {
    const got = selectSourcableWallets([trade("demo-wallet", "SELL"), trade(A, "SELL")], { sellersOnly: true });
    expect(got).toEqual([A]);
  });
});
