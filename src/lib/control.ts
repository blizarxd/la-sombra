import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { controlSettings } from "@/db/schema";

/**
 * Manual control switches over the paper experiments (single-row table).
 *
 * SAFETY: paper trading only. `liveEnabled` gates whether the ⚡ live ledger
 * opens SIMULATED copies; `liveStakeUsd` is the simulated size. Nothing here
 * can place a real order.
 */

export interface ControlSettings {
  liveEnabled: boolean;
  liveStakeUsd: number;
}

const SINGLETON_ID = "singleton";
const DEFAULTS: ControlSettings = { liveEnabled: true, liveStakeUsd: 5 };

/** Read the control settings, seeding the single row with defaults if absent. */
export function getControlSettings(db: Db): ControlSettings {
  const row = db.select().from(controlSettings).where(eq(controlSettings.id, SINGLETON_ID)).get();
  if (row) return { liveEnabled: row.liveEnabled, liveStakeUsd: row.liveStakeUsd };
  db.insert(controlSettings)
    .values({ id: SINGLETON_ID, ...DEFAULTS, updatedAt: new Date() })
    .run();
  return { ...DEFAULTS };
}

/** Persist a change. Stake is clamped to a sane paper range ($1–$100). */
export function setControlSettings(db: Db, patch: Partial<ControlSettings>): ControlSettings {
  const current = getControlSettings(db);
  const next: ControlSettings = {
    liveEnabled: patch.liveEnabled ?? current.liveEnabled,
    liveStakeUsd:
      patch.liveStakeUsd != null
        ? Math.min(100, Math.max(1, Math.round(patch.liveStakeUsd * 100) / 100))
        : current.liveStakeUsd,
  };
  db.update(controlSettings)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(controlSettings.id, SINGLETON_ID))
    .run();
  return next;
}
