import { describe, expect, it } from "vitest";
import { dailyCutDecision } from "@/scripts/operator-daily";

const TOKEN = "test-token";
const TODAY = "2026-07-16";
const settled = { lastCycleToken: TOKEN };
const opts = { hasWalletQueue: true, token: TOKEN };

describe("dailyCutDecision", () => {
  it("fires at 08:00 on Johan's clock when it has not run today", () => {
    expect(dailyCutDecision(settled, TODAY, 8, opts).run).toBe(true);
  });

  it("stays quiet outside the 08:00 hour", () => {
    expect(dailyCutDecision(settled, TODAY, 11, opts).run).toBe(false);
    expect(dailyCutDecision(settled, TODAY, 7, opts).run).toBe(false);
  });

  it("never runs twice on the same day", () => {
    const state = { ...settled, lastDailyRun: TODAY };
    expect(dailyCutDecision(state, TODAY, 8, opts).run).toBe(false);
  });

  /**
   * The 2026-07-16 outage in one test: the cut started at 08:00, the watchdog
   * killed it mid-way, and because nothing recorded that it had started, the
   * 11:00 tick looked identical to "not 8am yet" and gave up until tomorrow —
   * so the rule tuners, the AI cut and the EOD report never ran that day.
   */
  it("RESUMES a cut that started today but never finished, even outside the 08:00 hour", () => {
    const killedMidCycle = {
      ...settled,
      dailyProgress: { day: TODAY, done: ["scan-leaderboard.ts", "scan-crypto-markets.ts"] },
    };
    const d = dailyCutDecision(killedMidCycle, TODAY, 11, opts);
    expect(d.run).toBe(true);
    expect(d.reason).toContain("resuming");
    expect(d.doneToday).toEqual(["scan-leaderboard.ts", "scan-crypto-markets.ts"]);
  });

  it("does not resume yesterday's leftover progress — a new day starts clean", () => {
    const stale = { ...settled, dailyProgress: { day: "2026-07-15", done: ["scan-leaderboard.ts"] } };
    const d = dailyCutDecision(stale, TODAY, 11, opts);
    expect(d.run).toBe(false);
    expect(d.doneToday).toEqual([]);
  });

  it("a completed cut wins over leftover progress — no re-run", () => {
    const state = { lastDailyRun: TODAY, lastCycleToken: TOKEN, dailyProgress: { day: TODAY, done: ["ai-analyst.ts"] } };
    expect(dailyCutDecision(state, TODAY, 8, opts).run).toBe(false);
  });

  it("a token bump forces exactly one out-of-hours cut", () => {
    const old = { lastCycleToken: "yesterdays-token" };
    expect(dailyCutDecision(old, TODAY, 15, opts).run).toBe(true);
    // ...and once the cut records the new token + the day, it stops firing.
    expect(dailyCutDecision({ lastCycleToken: TOKEN, lastDailyRun: TODAY }, TODAY, 15, opts).run).toBe(false);
  });

  it("bootstraps immediately on a fresh deploy with no wallets, whatever the hour", () => {
    const d = dailyCutDecision(settled, TODAY, 3, { ...opts, hasWalletQueue: false });
    expect(d.run).toBe(true);
    expect(d.reason).toContain("bootstrap");
  });

  it("hands back the resume list so finished steps are not re-run", () => {
    const state = { ...settled, dailyProgress: { day: TODAY, done: ["scan-leaderboard.ts"] } };
    const { doneToday } = dailyCutDecision(state, TODAY, 8, opts);
    expect(doneToday).toContain("scan-leaderboard.ts");
  });
});
