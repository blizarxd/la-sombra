import { describe, expect, it } from "vitest";
import { TIME_STOP_HOURS, decideExit, isEligible } from "@/lib/exitBook";

const openArm = {
  armStatus: "open",
  armClosedAt: null,
  armResolvedAt: null,
  armExitPrice: null,
  currentPrice: 0.6,
  heldHours: 1,
};

describe("exitBook isEligible", () => {
  it("takes copies from any arm — the hypothesis is about the exit, not the entry", () => {
    expect(isEligible({ track: "core" })).toBe(true);
    expect(isEligible({ track: "live" })).toBe(true);
    expect(isEligible({ track: "crypto" })).toBe(true);
  });

  it("rejects La Crema, whose copies mirror the other arms", () => {
    expect(isEligible({ track: "elite" })).toBe(false);
  });
});

describe("decideExit — which door the position leaves by", () => {
  it("follows the wallet out when the arm exit-copied a sale", () => {
    // This is the event the whole book is built around, so it must be labelled
    // distinctly from a resolution — they had opposite returns in the record.
    expect(
      decideExit({ ...openArm, armStatus: "closed", armExitPrice: 0.8, armClosedAt: new Date() }),
    ).toEqual({ door: "salida-billetera", price: 0.8 });
  });

  it("marks an arm resolution as reaching the oracle — a MISS for this book", () => {
    expect(decideExit({ ...openArm, armStatus: "resolved", armExitPrice: 1 })).toEqual({
      door: "resolucion",
      price: 1,
    });
  });

  it("sells into a price that is no longer in doubt", () => {
    expect(decideExit({ ...openArm, currentPrice: 0.98 })).toEqual({
      door: "precio-decidido",
      price: 0.98,
    });
    expect(decideExit({ ...openArm, currentPrice: 0.02 })).toEqual({
      door: "precio-decidido",
      price: 0.02,
    });
  });

  it("cuts at the time stop when nothing else fired", () => {
    expect(decideExit({ ...openArm, heldHours: TIME_STOP_HOURS })).toEqual({
      door: "tiempo-agotado",
      price: 0.6,
    });
  });

  it("holds while the position is young and genuinely undecided", () => {
    expect(decideExit({ ...openArm, heldHours: TIME_STOP_HOURS - 0.1, currentPrice: 0.55 })).toBeNull();
  });

  it("prefers the wallet's own exit over the time stop", () => {
    // Both conditions true at once: the copied signal must win, otherwise the
    // book would record its best door as its worst one.
    const v = decideExit({
      ...openArm,
      armStatus: "closed",
      armExitPrice: 0.9,
      heldHours: TIME_STOP_HOURS + 5,
    });
    expect(v).toEqual({ door: "salida-billetera", price: 0.9 });
  });

  it("prefers a decided price over the time stop at the same instant", () => {
    const v = decideExit({ ...openArm, currentPrice: 0.99, heldHours: TIME_STOP_HOURS + 1 });
    expect(v?.door).toBe("precio-decidido");
  });

  it("waits rather than guessing when there is no price yet", () => {
    expect(decideExit({ ...openArm, currentPrice: null, heldHours: TIME_STOP_HOURS + 10 })).toBeNull();
  });

  it("waits when the arm settled but its exit price cannot be recovered", () => {
    expect(decideExit({ ...openArm, armStatus: "resolved", armExitPrice: null })).toBeNull();
  });

  it("honours a custom time stop", () => {
    expect(decideExit({ ...openArm, heldHours: 2, timeStopHours: 2 })?.door).toBe("tiempo-agotado");
    expect(decideExit({ ...openArm, heldHours: 2, timeStopHours: 3 })).toBeNull();
  });
});
