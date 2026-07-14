import Database from "better-sqlite3";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { observedTrades } from "@/db/schema";
import { selectByIdsChunked, SQLITE_VAR_LIMIT } from "@/lib/queries";

/**
 * Regression guard: a raw `inArray` over >32766 ids throws "too many SQL
 * variables" (it once 500'd Resumen + Rendimiento). selectByIdsChunked must
 * batch so an arbitrarily large id list is safe. We only ever need the `id`
 * column here, so a one-column table is enough to exercise the hazard.
 */
function memDb() {
  const db = drizzle(new Database(":memory:"));
  db.run("CREATE TABLE observed_trades (id text primary key)" as never);
  return db;
}
const selectIds = (db: ReturnType<typeof memDb>, batch: string[]) =>
  db.select({ id: observedTrades.id }).from(observedTrades).where(inArray(observedTrades.id, batch)).all();

describe("selectByIdsChunked (SQLite host-param limit)", () => {
  it("SQLITE_VAR_LIMIT stays under SQLite's 32766 cap", () => {
    expect(SQLITE_VAR_LIMIT).toBeLessThan(32766);
  });

  it("a raw inArray over 40k ids throws — proving the hazard is real", () => {
    const db = memDb();
    const ids = Array.from({ length: 40000 }, (_, i) => `id-${i}`);
    expect(() => selectIds(db, ids)).toThrow(/too many SQL variables/);
  });

  it("selectByIdsChunked over 40k ids does NOT throw and merges every batch", () => {
    const db = memDb();
    for (const id of ["id-5", "id-39999"]) {
      db.run(`INSERT INTO observed_trades (id) VALUES ('${id}')` as never);
    }
    const ids = Array.from({ length: 40000 }, (_, i) => `id-${i}`);
    const rows = selectByIdsChunked(ids, (batch) => selectIds(db, batch));
    expect(rows.map((r) => r.id).sort()).toEqual(["id-39999", "id-5"]);
  });

  it("dedupes ids and returns [] for an empty list", () => {
    const db = memDb();
    let batches = 0;
    const rows = selectByIdsChunked(["a", "a", "b"], (batch) => {
      batches++;
      expect(batch).toEqual(["a", "b"]); // deduped
      return selectIds(db, batch);
    });
    expect(batches).toBe(1);
    expect(rows).toEqual([]);
    expect(selectByIdsChunked([], () => [])).toEqual([]);
  });
});
