import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * READ-ONLY SAFETY SUITE.
 *
 * Asserts, by scanning the actual source tree, that no code path exists that
 * could submit an order, sign anything, or handle a private key. If someone
 * adds one, these tests fail loudly.
 */

const SRC = path.join(__dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const sources = files.map((f) => ({ file: path.relative(SRC, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }));

describe("no real-trade code path exists", () => {
  it("scans a non-trivial source tree (sanity)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("never handles private keys, seed phrases or signing", () => {
    const forbidden = [
      /privateKey/i,
      /private[_\s]key/i,
      /mnemonic/i,
      /seed\s*phrase/i,
      /signTransaction/i,
      /signTypedData/i,
      /signOrder/i,
      /\bwallet\.sign/i,
      /personal_sign/i,
    ];
    for (const { file, text } of sources) {
      for (const pattern of forbidden) {
        // logger redaction REFERENCES key-shaped patterns to mask them; that's the one allowed mention.
        if (file === "lib/logger.ts") continue;
        expect(text, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("never imports trading/signing libraries", () => {
    const forbiddenImports = [
      /from\s+["']ethers["']/,
      /from\s+["']viem["']/,
      /from\s+["']wagmi["']/,
      /from\s+["']web3["']/,
      /@polymarket\/clob-client/,
      /@polymarket\/order-utils/,
    ];
    for (const { file, text } of sources) {
      for (const pattern of forbiddenImports) {
        expect(text, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const banned of ["ethers", "viem", "wagmi", "web3", "@polymarket/clob-client"]) {
      expect(deps).not.toContain(banned);
    }
  });

  it("never calls order-submission endpoints or functions", () => {
    const forbidden = [
      /clob\.polymarket\.com\/order/i,
      /\bpostOrder\b/,
      /\bcreateOrder\b/,
      /\bsubmitOrder\b/,
      /\bplaceOrder\b/,
      /\bcancelOrder\b/,
      /\/orders?\b.*method/i,
    ];
    for (const { file, text } of sources) {
      for (const pattern of forbidden) {
        expect(text, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("adapter layer is GET-only: only http.ts touches fetch, and only with GET", () => {
    const adapterFiles = sources.filter((s) => s.file.startsWith("lib/adapters/"));
    expect(adapterFiles.length).toBeGreaterThanOrEqual(3);
    for (const { file, text } of adapterFiles) {
      if (file === "lib/adapters/http.ts") {
        expect(text).toMatch(/method:\s*"GET"/);
        expect(text).not.toMatch(/"POST"|"PUT"|"DELETE"|"PATCH"/);
      } else {
        expect(text, `${file} must go through httpGet, never fetch directly`).not.toMatch(/\bfetch\s*\(/);
      }
    }
  });

  it("the only POST in the entire codebase is Telegram notifications", () => {
    const posters = sources.filter((s) => /method:\s*["']POST["']/i.test(s.text));
    expect(posters.map((p) => p.file)).toEqual(["lib/telegram.ts"]);
    const telegram = posters[0];
    // and it can only talk to api.telegram.org
    expect(telegram.text).toMatch(/https:\/\/api\.telegram\.org/);
    expect(telegram.text).not.toMatch(/polymarket/i);
  });

  it("paper engine writes only to the local database (no network access at all)", () => {
    const engine = sources.find((s) => s.file === "lib/paper/engine.ts")!;
    expect(engine).toBeDefined();
    expect(engine.text).not.toMatch(/\bfetch\s*\(/);
    expect(engine.text).not.toMatch(/https?:\/\//);
  });
});
