/**
 * Open-position (parked-capital) projection by resolution window.
 *
 * The core book holds each copy to resolution, so the number of positions open
 * at any moment is governed by Little's Law:  L = λ · W
 *   L = open positions in steady state
 *   λ = arrival rate of NEW copies that qualify for the window (copies/day)
 *   W = average time a qualifying copy stays open (days)
 *
 * Capping the max time-to-resolution shrinks BOTH: fewer copies qualify (λ drops)
 * AND the ones that do resolve faster (W drops) — so the open pile shrinks more
 * than linearly. This lets us show how many open positions (= parked capital)
 * each window implies, so the window is chosen against real bankroll, not guessed.
 */

export interface WindowProjection {
  windowDays: number;
  qualifyShare: number; // 0-1: share of historical copies that resolve within the window
  avgHoldDays: number; // mean hold of the qualifying copies
  copiesPerDay: number; // qualifying arrivals per day (λ · qualifyShare)
  projectedOpen: number; // steady-state open positions (Little's Law)
}

/**
 * @param holdDays   hold times (open->settle, in days) of already-settled copies
 * @param arrivalPerDay  total new copies opened per day (all windows)
 * @param windows    candidate max-resolution windows, in days
 */
export function projectOpenByWindow(
  holdDays: number[],
  arrivalPerDay: number,
  windows: number[],
): WindowProjection[] {
  const total = holdDays.length;
  return windows.map((W) => {
    const qualifying = holdDays.filter((h) => h <= W);
    const qualifyShare = total > 0 ? qualifying.length / total : 0;
    const avgHoldDays =
      qualifying.length > 0 ? qualifying.reduce((a, b) => a + b, 0) / qualifying.length : 0;
    const copiesPerDay = arrivalPerDay * qualifyShare;
    const projectedOpen = copiesPerDay * avgHoldDays; // L = λ · W
    return {
      windowDays: W,
      qualifyShare: Math.round(qualifyShare * 1000) / 1000,
      avgHoldDays: Math.round(avgHoldDays * 10) / 10,
      copiesPerDay: Math.round(copiesPerDay * 10) / 10,
      projectedOpen: Math.round(projectedOpen),
    };
  });
}
