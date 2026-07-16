import { describe, expect, it } from "vitest";
import { comboLegResolutions } from "@/db/schema";
import { judgeAffirmativeLeg } from "@/lib/comboLegs";
import { testDb } from "./helpers/db";

/**
 * The leg cache is what makes a big open book affordable: a resolved leg is
 * FINAL, so it must cost exactly one gamma call in its whole lifetime. Before
 * it existed, combo-tick re-fetched every leg every 20 minutes, burned its
 * lookup budget on games finished days ago, and never reached the combos at the
 * back of the queue.
 */
describe("combo leg resolution cache", () => {
  const row = {
    question: "will argentina win on 2026-07-15?",
    endDateMs: 1_800_000_000_000,
    outcomesJson: '["Yes", "No"]',
    outcomePricesJson: '["1", "0"]',
    resolvedAt: new Date(),
  };

  it("round-trips a resolution and keys it by the lowercased question", () => {
    const db = testDb();
    db.insert(comboLegResolutions).values(row).run();
    const got = db.select().from(comboLegResolutions).all();
    expect(got).toHaveLength(1);
    expect(got[0].question).toBe("will argentina win on 2026-07-15?");
    expect(got[0].endDateMs).toBe(row.endDateMs);
  });

  it("re-inserting the same leg is a no-op — the tick must never fail on a duplicate", () => {
    const db = testDb();
    db.insert(comboLegResolutions).values(row).onConflictDoNothing().run();
    expect(() =>
      db.insert(comboLegResolutions).values({ ...row, outcomePricesJson: '["0", "1"]' }).onConflictDoNothing().run(),
    ).not.toThrow();
    const got = db.select().from(comboLegResolutions).all();
    expect(got).toHaveLength(1);
    // The FIRST (final) resolution wins — a later write can't flip a verdict.
    expect(got[0].outcomePricesJson).toBe('["1", "0"]');
  });

  it("a cached row rebuilds the same verdict the live market gave", () => {
    const db = testDb();
    db.insert(comboLegResolutions).values(row).run();
    const hit = db.select().from(comboLegResolutions).all()[0];
    // This is exactly how combo-tick reconstitutes a cached leg.
    expect(
      judgeAffirmativeLeg({
        closed: true,
        umaResolutionStatus: "resolved",
        outcomes: hit.outcomesJson,
        outcomePrices: hit.outcomePricesJson,
      }),
    ).toBe("won");
  });

  it("a cached LOSS still reads as a loss — the signal that kills a parlay survives the cache", () => {
    const db = testDb();
    db.insert(comboLegResolutions).values({ ...row, outcomePricesJson: '["0", "1"]' }).run();
    const hit = db.select().from(comboLegResolutions).all()[0];
    expect(
      judgeAffirmativeLeg({
        closed: true,
        umaResolutionStatus: "resolved",
        outcomes: hit.outcomesJson,
        outcomePrices: hit.outcomePricesJson,
      }),
    ).toBe("lost");
  });

  it("keeps legs from different games apart", () => {
    const db = testDb();
    db.insert(comboLegResolutions).values(row).run();
    db.insert(comboLegResolutions).values({ ...row, question: "will spain win on 2026-07-14?" }).run();
    expect(db.select().from(comboLegResolutions).all()).toHaveLength(2);
  });
});
