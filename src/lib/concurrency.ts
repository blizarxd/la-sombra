/**
 * Run an async mapper over `items` with at most `limit` in flight at once.
 *
 * Results come back in input order. A rejection propagates (callers decide what
 * a failed item means) — nothing here swallows an upstream error into fake data.
 *
 * Exists because monitor-trades walked ~1000 tracked wallets with one sequential
 * API call each. That was fine at ~300 wallets and fatal at ~1000: the pass grew
 * past the 2-minute live tick it feeds, so the live book could never see an
 * in-play bet while the game was still running.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** Split into fixed-size chunks (bounds memory when fanning out over a big list). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
