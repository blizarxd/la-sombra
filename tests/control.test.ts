import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { controlSettings } from "@/db/schema";
import { getControlSettings, setControlSettings } from "@/lib/control";
import type { Db } from "@/db/client";

function freshDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    `CREATE TABLE control_settings (
      id text PRIMARY KEY,
      live_enabled integer NOT NULL DEFAULT 1,
      live_stake_usd real NOT NULL DEFAULT 5,
      updated_at integer NOT NULL
    );`,
  );
  return drizzle(sqlite, { schema: { controlSettings } }) as unknown as Db;
}

describe("control settings (⚡ live on/off + stake, paper only)", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("seeds defaults on first read: live on, $5 stake", () => {
    expect(getControlSettings(db)).toEqual({ liveEnabled: true, liveStakeUsd: 5 });
  });

  it("persists the on/off switch", () => {
    setControlSettings(db, { liveEnabled: false });
    expect(getControlSettings(db).liveEnabled).toBe(false);
  });

  it("persists a custom stake", () => {
    setControlSettings(db, { liveStakeUsd: 12.5 });
    expect(getControlSettings(db).liveStakeUsd).toBe(12.5);
  });

  it("clamps the stake to the sane paper range ($1–$100)", () => {
    expect(setControlSettings(db, { liveStakeUsd: 0 }).liveStakeUsd).toBe(1);
    expect(setControlSettings(db, { liveStakeUsd: 9999 }).liveStakeUsd).toBe(100);
  });

  it("a partial patch leaves the other field untouched", () => {
    setControlSettings(db, { liveEnabled: false, liveStakeUsd: 20 });
    setControlSettings(db, { liveStakeUsd: 8 });
    expect(getControlSettings(db)).toEqual({ liveEnabled: false, liveStakeUsd: 8 });
  });
});
