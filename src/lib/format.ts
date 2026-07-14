/** Display formatters shared by dashboard pages. */

/**
 * Project timezone: everything (dashboard times + the morning report hour) is
 * shown in UTC-4 so it always matches Johan's clock, regardless of where the
 * server runs. America/Caracas is a permanent UTC-4 zone (no daylight saving).
 */
export const APP_TZ = "America/Caracas";

export function money(v: number | null | undefined, opts?: { sign?: boolean }): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = opts?.sign && v > 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(0)}¢`;
}

export function score(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Math.round(v)}`;
}

export function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

export function when(d: Date | number | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: APP_TZ,
  });
}

/** Calendar day (YYYY-MM-DD) of a timestamp in the project timezone (UTC-4). */
export function dayKeyTz(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  // en-CA renders as YYYY-MM-DD; timeZone pins it to UTC-4 (Johan's clock).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Hour (0-23) of a timestamp in the project timezone (UTC-4) — the daily-cycle cut fires by this. */
export function hourInAppTz(d: Date | number = new Date()): number {
  const date = typeof d === "number" ? new Date(d) : d;
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, hour: "2-digit", hour12: false }).format(date);
  return Number(hour) % 24; // "24" at midnight in some locales/ICU versions
}

/** Short human label (e.g. "13 jul") for a YYYY-MM-DD day key, in Spanish. */
export function dayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  if (!y || !m || !d) return dayKey;
  return `${d} ${months[m - 1] ?? ""}`;
}

export function hoursLeft(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "—";
  if (h < 0) return "past due";
  if (h < 48) return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}

export function isDemo(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => t?.includes("[DEMO]") || t?.includes("demo-") || t?.startsWith?.("0xdemo"));
}

export function parseJsonList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
