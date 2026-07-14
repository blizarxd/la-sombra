import { AdapterError } from "./types";

// polymarket.com (the WEB frontend, not the APIs) answers with >16KB of
// response headers, which overflows Node fetch's default header budget
// (UND_ERR_HEADERS_OVERFLOW, seen live 2026-07-13). We fix it with an undici
// Agent that allows a bigger header — but undici is loaded LAZILY, and ONLY by
// the HTML scraper. It must NEVER be imported at module load: this file is the
// single network entry point for the ENTIRE adapter layer, so a bad/missing
// undici here would crash monitor/score/every core script on import. The core
// bot must not depend on a combo-book-only library.
let htmlAgentPromise: Promise<{ fetch: typeof fetch; dispatcher: unknown }> | null = null;
let usingFallbackFetch = false; // true when undici failed to load (global fetch: 16KB header cap)
function getHtmlFetcher(): Promise<{ fetch: typeof fetch; dispatcher: unknown }> {
  if (!htmlAgentPromise) {
    htmlAgentPromise = import("undici")
      .then((u) => ({ fetch: u.fetch as unknown as typeof fetch, dispatcher: new u.Agent({ maxHeaderSize: 64 * 1024 }) }))
      // undici unavailable? fall back to global fetch (works unless headers overflow).
      .catch(() => {
        usingFallbackFetch = true;
        return { fetch, dispatcher: undefined };
      });
  }
  return htmlAgentPromise;
}

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
  const { fetch: htmlFetch, dispatcher } = await getHtmlFetcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await htmlFetch(url, {
      method: "GET", // read-only, always
      headers: {
        Accept: "text/html,application/xhtml+xml",
        // A browser-ish UA: polymarket.com serves the full server-rendered
        // table to it (verified live 2026-07-13).
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) la-sombra-research (paper-only)",
      },
      // `dispatcher` is an undici-only option; harmless when it's undefined.
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
    } as RequestInit);
  } catch (err) {
    clearTimeout(timer);
    // "fetch failed" alone is useless for diagnosis — surface the CAUSE chain
    // (e.g. UND_ERR_HEADERS_OVERFLOW vs ECONNRESET vs a TLS reset) so the
    // /combos diagnostic can tell "our fetch config" apart from a real block.
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? (err.cause as { message?: string; code?: string } | undefined) : undefined;
    const causeStr = cause ? ` — cause: ${cause.code ?? ""} ${cause.message ?? ""}`.trimEnd() : "";
    const fetcherNote = usingFallbackFetch ? " [undici unavailable — global fetch, 16KB header cap]" : "";
    throw new AdapterError(source, url, null, `network error: ${msg}${causeStr}${fetcherNote}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AdapterError(source, url, res.status, `HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.text();
}
