import { Agent, fetch as undiciFetch } from "undici";
import { AdapterError } from "./types";

// polymarket.com (the WEB frontend, not the APIs) answers with >16KB of
// response headers, which overflows Node fetch's default header budget
// (UND_ERR_HEADERS_OVERFLOW, seen live 2026-07-13). A dedicated undici agent
// with a bigger header allowance fixes it; GET-only like everything here.
const htmlAgent = new Agent({ maxHeaderSize: 64 * 1024 });

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

/**
 * GET a text/HTML resource (used to read server-rendered pages like the Combo
 * Cup leaderboard, which has no JSON API). Same hard GET-only guarantee as
 * httpGet — scraping is still read-only research.
 */
export async function httpGetText(source: string, url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: "GET", // read-only, always
      headers: {
        Accept: "text/html,application/xhtml+xml",
        // A browser-ish UA: polymarket.com serves the full server-rendered
        // table to it (verified live 2026-07-13).
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) la-sombra-research (paper-only)",
      },
      dispatcher: htmlAgent,
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
  return await res.text();
}
