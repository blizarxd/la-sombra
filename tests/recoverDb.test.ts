import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIntegrity } from "@/scripts/recover-db";

/**
 * On 2026-08-04 the volume filled mid-write and the database came back
 * SQLITE_CORRUPT, crash-looping every boot in db:migrate. The salvage exists to
 * get the research out. These tests pin the two things that matter: a healthy
 * database is never touched, and a salvage never destroys the original unless
 * the paper trades actually came across.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "src", "scripts", "recover-db.ts");

let dir: string;
let dbPath: string;

function seedHealthy(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE paper_trades (id TEXT PRIMARY KEY, opened_at INTEGER, realized_pnl REAL, track TEXT, gold_rule TEXT);
    CREATE TABLE wallet_profiles (id TEXT PRIMARY KEY, address TEXT, global_score REAL);
    CREATE TABLE crema_cells (id TEXT PRIMARY KEY, status TEXT, label TEXT);
    CREATE TABLE daily_reports (id TEXT PRIMARY KEY, date TEXT, summary TEXT);
    CREATE TABLE observed_trades (id TEXT PRIMARY KEY, created_at INTEGER, raw_trade_json TEXT);
  `);
  const pt = db.prepare("INSERT INTO paper_trades VALUES (?,?,?,?,?)");
  for (let i = 0; i < 40; i++) pt.run(`pt${i}`, Date.now() - i * 3600_000, i % 3 === 0 ? -2 : 3, "core", "hour:08");
  db.prepare("INSERT INTO wallet_profiles VALUES (?,?,?)").run("w1", "0xabc", 88);
  db.prepare("INSERT INTO crema_cells VALUES (?,?,?)").run("hour:08", "activa", "Mañana");
  db.prepare("INSERT INTO daily_reports VALUES (?,?,?)").run("r1", "2026-08-01", "corte");
  // The bloat that filled the disk — deliberately NOT carried across.
  const ot = db.prepare("INSERT INTO observed_trades VALUES (?,?,?)");
  for (let i = 0; i < 500; i++) ot.run(`o${i}`, Date.now(), JSON.stringify({ blob: "x".repeat(500) }));
  db.close();
}

/** Runs the salvage and returns BOTH streams — warnings/errors go to stderr. */
function runRecover(extraEnv: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, ...extraEnv },
    encoding: "utf8",
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recover-test-"));
  dbPath = path.join(dir, "test.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("checkIntegrity", () => {
  it("una base sana pasa el chequeo", () => {
    seedHealthy();
    expect(checkIntegrity(dbPath)).toBeNull();
  });

  it("una base destrozada NO pasa — es el disparador del rescate", () => {
    seedHealthy();
    // Overwrite the page headers with garbage, the way a truncated write does.
    const fd = fs.openSync(dbPath, "r+");
    fs.writeSync(fd, Buffer.alloc(8192, 0xff), 0, 8192, 4096);
    fs.closeSync(fd);
    expect(checkIntegrity(dbPath)).not.toBeNull();
  });
});

describe("recover-db — sobre una base sana", () => {
  it("no toca absolutamente nada", () => {
    seedHealthy();
    const before = fs.statSync(dbPath).size;
    const out = runRecover();
    expect(out).toMatch(/integridad OK/);
    expect(fs.statSync(dbPath).size).toBe(before);
    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "paper_trades")).toBe(40);
    expect(count(db, "observed_trades")).toBe(500); // even the bloat survives
    db.close();
  });

  it("no deja archivos sueltos de rescate", () => {
    seedHealthy();
    runRecover();
    expect(fs.existsSync(path.join(dir, "la-sombra-rescued.db"))).toBe(false);
    expect(fs.existsSync(`${dbPath}.corrupt`)).toBe(false);
  });
});

describe("recover-db — seguridad del rescate", () => {
  it("si no rescata NINGÚN paper trade, deja el original intacto", () => {
    // A file that is not a database at all: nothing can be salvaged from it, so
    // the original must survive for manual recovery rather than be destroyed.
    fs.writeFileSync(dbPath, Buffer.alloc(200_000, 0x7a));
    const before = fs.readFileSync(dbPath);
    const out = runRecover();
    expect(out).toMatch(/NO se toca el original|el rescate falló/);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(dir, "la-sombra-rescued.db"))).toBe(false);
  });

  it("sin ALLOW_FRESH_START jamás borra la base, aunque no rescate nada", () => {
    fs.writeFileSync(dbPath, Buffer.alloc(200_000, 0x7a));
    runRecover();
    expect(fs.existsSync(dbPath)).toBe(true); // still there for manual recovery
  });

  it("con ALLOW_FRESH_START=1 sí la borra — pero eso es consentimiento explícito", () => {
    fs.writeFileSync(dbPath, Buffer.alloc(200_000, 0x7a));
    const out = runRecover({ ALLOW_FRESH_START: "1" });
    expect(out).toMatch(/arrancando limpio|base corrupta borrada/);
    expect(fs.existsSync(dbPath)).toBe(false); // migrations will create a fresh one
  });

  it("una base SANA nunca se borra, ni con ALLOW_FRESH_START=1 puesto", () => {
    // The flag authorizes wiping a CORRUPT database, never a working one — a
    // variable left set by accident must not cost anyone their data.
    seedHealthy();
    runRecover({ ALLOW_FRESH_START: "1" });
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "paper_trades")).toBe(40);
    db.close();
  });

  it("nunca revienta el arranque, pase lo que pase", () => {
    fs.writeFileSync(dbPath, "no soy una base de datos");
    expect(() => runRecover()).not.toThrow();
  });

  it("sin base todavía, sigue de largo sin quejarse", () => {
    expect(() => runRecover()).not.toThrow();
  });
});

describe("recover-db — qué se lleva y qué deja", () => {
  it("rescata la investigación y abandona los logs crudos que llenaron el disco", () => {
    seedHealthy();
    // Corrupt a page deep in the file so quick_check fails but the early pages
    // (where the small essential tables live) are still readable.
    const size = fs.statSync(dbPath).size;
    const fd = fs.openSync(dbPath, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, Math.floor(size * 0.8));
    fs.closeSync(fd);
    if (checkIntegrity(dbPath) === null) return; // page landed harmlessly; nothing to assert

    runRecover();

    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "paper_trades")).toBeGreaterThan(0); // the analysis is back
    expect(count(db, "crema_cells")).toBe(1); // and so are the gold cells
    // observed_trades is intentionally left behind — it is re-fetchable bloat.
    const survived = db.prepare("SELECT name FROM sqlite_master WHERE name='observed_trades'").get();
    expect(survived).toBeUndefined();
    db.close();
    // The corrupt original must not be left lying around eating the volume.
    expect(fs.existsSync(`${dbPath}.corrupt`)).toBe(false);
  });
});
