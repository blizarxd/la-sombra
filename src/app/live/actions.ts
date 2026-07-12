"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { setControlSettings } from "@/lib/control";

/**
 * Server action for the ⚡ live control panel. Paper trading only: this toggles
 * whether the SIMULATED live ledger opens copies and sets the simulated stake.
 * It can never place a real order.
 */
export async function updateLiveControls(formData: FormData) {
  const db = getDb();
  const liveEnabled = formData.get("liveEnabled") === "on";
  const rawStake = formData.get("liveStakeUsd");
  const parsed = rawStake != null ? Number(rawStake) : NaN;
  setControlSettings(db, {
    liveEnabled,
    ...(Number.isFinite(parsed) ? { liveStakeUsd: parsed } : {}),
  });
  revalidatePath("/live");
}
