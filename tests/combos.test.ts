import { describe, expect, it } from "vitest";
import {
  addressFromProfileHref,
  COMBO_LOSS_TIMEOUT_MS,
  type ComboActivityEvent,
  comboLegCount,
  computeComboWalletStats,
  decideComboSettlement,
  extractProxyWalletFromProfileHtml,
  isSyntheticComboConditionId,
  parseComboLeaderboardHtml,
} from "@/lib/combos";

// A real row captured from polymarket.com/leaderboard/combos/yesterday on
// 2026-07-13 (classes trimmed). The parser must survive this exact shape.
const ROW_PSEUDONYM = `<tr class="cursor-pointer"><td><button type="button" aria-label="View @Indolent-Constant&#x27;s combo" class="block">1</button></td><td><a data-profile-link="true" rel="nofollow ugc" class="group" href="/@0xd4ebc3421613de81017894c309fe557146207ba3-1778312483347"><div class="rounded-full"></div><span class="truncate">@Indolent-Constant</span></a></td><td><span class="text-body-sm">3 legs</span></td><td class="tabular-nums text-green-600">+4,446%</td><td>$53<span class="mx-2">→</span><span class="text-text-primary">$2,426</span></td><td><span>—</span></td></tr>`;
const ROW_PROFILE = `<tr><td><button aria-label="View @Dr.Daleks&#x27;s combo">5</button></td><td><a data-profile-link="true" href="/es/profile/0x2e1231583597d50bcaf932c55c924055c1a49ba1"><span class="truncate">@Dr.Daleks</span></a></td><td><span>4 selecciones</span></td><td>+2,549%</td><td>$70<span class="mx-2">→</span><span class="x">$1,852</span></td></tr>`;
const ROW_USERNAME = `<tr><td><button aria-label="View @lancel777&#x27;s combo">3</button></td><td><a data-profile-link="true" href="/es/@lancel777"><span class="truncate">@lancel777</span></a></td><td><span>6 legs</span></td><td>+3,126%</td><td>$14<span class="a">→</span><span class="b">$461</span></td></tr>`;

describe("parseComboLeaderboardHtml", () => {
  it("parses a pseudonymous handle that embeds the address", () => {
    const rows = parseComboLeaderboardHtml(`<table>${ROW_PSEUDONYM}</table>`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rank: 1,
      username: "Indolent-Constant",
      address: "0xd4ebc3421613de81017894c309fe557146207ba3",
      legs: 3,
      returnPct: 4446,
      betUsd: 53,
      payoutUsd: 2426,
    });
  });

  it("parses direct profile hrefs and Spanish 'selecciones'", () => {
    const rows = parseComboLeaderboardHtml(ROW_PROFILE);
    expect(rows[0].address).toBe("0x2e1231583597d50bcaf932c55c924055c1a49ba1");
    expect(rows[0].legs).toBe(4);
    expect(rows[0].rank).toBe(5);
  });

  it("keeps username-only rows for later profile resolution", () => {
    const rows = parseComboLeaderboardHtml(ROW_USERNAME);
    expect(rows[0].address).toBeNull();
    expect(rows[0].profilePath).toBe("/@lancel777");
    expect(rows[0].username).toBe("lancel777");
  });

  it("returns [] on an unrecognizable page (caller must stop, never fake)", () => {
    expect(parseComboLeaderboardHtml("<html><body>oops</body></html>")).toEqual([]);
  });
});

describe("addressFromProfileHref / profile HTML", () => {
  it("handles locale prefixes and query strings", () => {
    expect(addressFromProfileHref("/es/profile/0xABCDEF1234567890abcdef1234567890ABCDEF12")).toBe(
      "0xabcdef1234567890abcdef1234567890abcdef12",
    );
    expect(addressFromProfileHref("/@0xd4ebc3421613de81017894c309fe557146207ba3-1778312483347")).toBe(
      "0xd4ebc3421613de81017894c309fe557146207ba3",
    );
    expect(addressFromProfileHref("/@lancel777")).toBeNull();
  });

  it("extracts proxyWallet from escaped JSON in profile HTML", () => {
    const html = 'push("{\\"proxyWallet\\":\\"0xceb169f216ba4db58ac0753a3d3823593e75f700\\"}")';
    expect(extractProxyWalletFromProfileHtml(html)).toBe("0xceb169f216ba4db58ac0753a3d3823593e75f700");
    expect(extractProxyWalletFromProfileHtml("<html></html>")).toBeNull();
  });
});

describe("combo identification", () => {
  it("flags synthetic combo conditionIds (long zero tail)", () => {
    expect(isSyntheticComboConditionId("0x032eb2473617c629eebf25b6b548aedf9f0000000000000000000000000000")).toBe(true);
    expect(
      isSyntheticComboConditionId("0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892"),
    ).toBe(false);
    expect(isSyntheticComboConditionId(null)).toBe(false);
  });

  it("counts legs from the AND-joined title", () => {
    expect(comboLegCount("A AND B AND C")).toBe(3);
    expect(comboLegCount("Single market")).toBe(1);
    expect(comboLegCount(null)).toBe(0);
  });
});

const HOUR = 3600 * 1000;
const ev = (over: Partial<ComboActivityEvent>): ComboActivityEvent => ({
  type: "TRADE",
  side: "BUY",
  conditionId: "0xc0000000000000000000000000000000000000000000000000000000000000",
  isCombo: true,
  price: 0.1,
  usdcSize: 20,
  title: "A AND B",
  timestampMs: 0,
  transactionHash: null,
  ...over,
});

describe("computeComboWalletStats", () => {
  it("computes cashflow-honest 30d stats", () => {
    const now = 100 * 24 * HOUR;
    const events: ComboActivityEvent[] = [
      ev({ usdcSize: 20, timestampMs: now - 5 * 24 * HOUR }), // mature buy
      ev({ usdcSize: 30, timestampMs: now - 1 * HOUR }), // fresh buy (not mature)
      ev({ type: "REDEEM", side: null, usdcSize: 90, timestampMs: now - 4 * 24 * HOUR }),
      ev({ side: "SELL", usdcSize: 8, timestampMs: now - 2 * 24 * HOUR }),
      ev({ usdcSize: 999, timestampMs: now - 40 * 24 * HOUR }), // outside window
      ev({ isCombo: false, usdcSize: 50, timestampMs: now - HOUR }), // not a combo
    ];
    const s = computeComboWalletStats(events, now);
    expect(s.buys).toBe(2);
    expect(s.redeems).toBe(1);
    expect(s.staked).toBe(50);
    expect(s.redeemed).toBe(90);
    expect(s.soldBack).toBe(8);
    expect(s.netPnl).toBe(48); // 90 + 8 - 50
    expect(s.matureBuys).toBe(1);
    expect(s.estWinRate).toBe(1);
  });

  it("returns null win rate with no mature buys", () => {
    const s = computeComboWalletStats([ev({ timestampMs: 99 * 24 * HOUR })], 100 * 24 * HOUR);
    expect(s.estWinRate).toBeNull();
  });
});

describe("decideComboSettlement", () => {
  const cid = "0xabc0000000000000000000000000000000000000000000000000000000000000";
  const trade = { conditionId: cid, openedAtMs: 10 * 24 * HOUR };

  it("WIN when the source wallet redeems the same combo", () => {
    const events = [ev({ type: "REDEEM", side: null, conditionId: cid, usdcSize: 150, timestampMs: trade.openedAtMs + HOUR })];
    expect(decideComboSettlement(trade, events, trade.openedAtMs + 2 * HOUR)).toEqual({
      kind: "win",
      payoutSeen: 150,
    });
  });

  it("CASH-OUT when the wallet sells, at their price", () => {
    const events = [ev({ side: "SELL", conditionId: cid, price: 0.3, timestampMs: trade.openedAtMs + HOUR })];
    expect(decideComboSettlement(trade, events, trade.openedAtMs + 2 * HOUR)).toEqual({
      kind: "cashout",
      price: 0.3,
    });
  });

  it("ignores activity on OTHER combos and holds", () => {
    const events = [ev({ type: "REDEEM", side: null, conditionId: "0xdif0000000000000000000000000000000000000", timestampMs: trade.openedAtMs + HOUR })];
    expect(decideComboSettlement(trade, events, trade.openedAtMs + 2 * HOUR)).toEqual({ kind: "hold" });
  });

  it("ignores the wallet's own BUY (it is not a settlement signal)", () => {
    const events = [ev({ conditionId: cid, timestampMs: trade.openedAtMs })];
    expect(decideComboSettlement(trade, events, trade.openedAtMs + HOUR)).toEqual({ kind: "hold" });
  });

  it("LOSS by labeled timeout after 7 days without redeem/sell", () => {
    expect(decideComboSettlement(trade, [], trade.openedAtMs + COMBO_LOSS_TIMEOUT_MS + 1)).toEqual({
      kind: "loss_timeout",
    });
    expect(decideComboSettlement(trade, [], trade.openedAtMs + COMBO_LOSS_TIMEOUT_MS - 1)).toEqual({
      kind: "hold",
    });
  });
});
