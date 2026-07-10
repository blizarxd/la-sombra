import { AdapterError } from "./types";

/**
 * The ONLY network entry point for market-data adapters.
 *
 * SAFETY: this wrapper hard-enforces GET. There is no code path in the
 * adapter layer that can POST, sign, or submit anything. If someone tries
 * to add one, the safety test suite fails.
 */
export async function httpGet(source: string, url: string, timeoutMs = 20000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET", // read-only, always
      headers: { Accept: "application/json", "User-Agent": "la-sombra-research/0.1 (paper-only)" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdapterError(source, url, null, `network error: ${msg}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AdapterError(source, url, res.status, `HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  try {
    return await res.json();
  } catch {
    throw new AdapterError(source, url, res.status, "response was not valid JSON");
  }
}
