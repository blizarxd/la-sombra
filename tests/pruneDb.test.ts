import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RETENTION } from "@/scripts/prune-db";

/**
 * The volume filled to 100% on 2026-08-04 and took production down. The fix
 * prunes raw API payloads — but a pruner that eats research data would be far
 * worse than a full disk, so these tests pin exactly what it may and may not
 * touch, against a REAL database file (the script talks to sqlite directly).
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "src", "scripts", "prune-db.ts");
const DAY = 24 * 3600 * 1000;

let dir: string;
let dbPath: string;

const ago = (days: number) => Date.now() - days * DAY;

function seed(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE paper_trades (id TEXT PRIMARY KEY, opened_at INTEGER, realized_pnl REAL, track TEXT);
    CREATE TABLE observed_trades (id TEXT PRIMARY KEY, created_at INTEGER, raw_trade_json TEXT, wallet_address TEXT);
    CREATE TABLE market_snapshots (id TEXT PRIMARY KEY, collected_at INTEGER, raw_market_json TEXT);
    CREATE TABLE pnl_snapshots (id TEXT PRIMARY KEY, collected_at INTEGER, pnl REAL);
    CREATE TABLE decision_journal (id TEXT PRIMARY KEY, created_at INTEGER, reasons_json TEXT, risks_json TEXT, blocked_gate TEXT);
    CREATE TABLE crema_cells (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE daily_reports (id TEXT PRIMARY KEY, date TEXT);
  `);
  const bigJson = JSON.stringify({ payload: "x".repeat(4000) });

  // Paper trades across the whole history — the analysis rests on these.
  const pt = db.prepare("INSERT INTO paper_trades VALUES (?,?,?,?)");
  for (let i = 0; i < 60; i++) pt.run(`pt${i}`, ago(i), 1.5, "core");

  const ot = db.prepare("INSERT INTO observed_trades VALUES (?,?,?,?)");
  for (let i = 0; i < 60; i++) ot.run(`ot${i}`, ago(i), bigJson, "0xabc");

  const ms = db.prepare("INSERT INTO market_snapshots VALUES (?,?,?)");
  for (let i = 0; i < 30; i++) ms.run(`ms${i}`, ago(i), bigJson);

  const ps = db.prepare("INSERT INTO pnl_snapshots VALUES (?,?,?)");
  for (let i = 0; i < 30; i++) ps.run(`ps${i}`, ago(i), 0.5);

  const dj = db.prepare("INSERT INTO decision_journal VALUES (?,?,?,?,?)");
  for (let i = 0; i < 30; i++) dj.run(`dj${i}`, ago(i), bigJson, bigJson, "minScore");

  db.prepare("INSERT INTO crema_cells VALUES (?,?)").run("hour:08", "activa");
  db.prepare("INSERT INTO daily_reports VALUES (?,?)").run("r1", "2026-07-20");
  db.close();
  return new Database(dbPath, { readonly: true });
}

function runPrune(...args: string[]): void {
  execFileSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: "pipe",
  });
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-test-"));
  dbPath = path.join(dir, "test.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prune-db — lo que NUNCA debe tocar", () => {
  it("no borra ni un solo paper trade, por viejo que sea", () => {
    seed().close();
    runPrune();
    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "paper_trades")).toBe(60);
    // and the PnL is intact, not just the row count
    const sum = (db.prepare("SELECT SUM(realized_pnl) s FROM paper_trades").get() as { s: number }).s;
    expect(sum).toBeCloseTo(90, 5);
    db.close();
  });

  it("no toca las celdas del motor ni los reportes diarios", () => {
    seed().close();
    runPrune();
    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "crema_cells")).toBe(1);
    expect(count(db, "daily_reports")).toBe(1);
    db.close();
  });

  it("conserva las FILAS del diario de decisiones — solo vacía su texto", () => {
    seed().close();
    runPrune();
    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "decision_journal")).toBe(30);
    // the column the skip-autopsy reads survives untouched
    const gates = (db.prepare("SELECT COUNT(*) n FROM decision_journal WHERE blocked_gate='minScore'").get() as { n: number }).n;
    expect(gates).toBe(30);
    db.close();
  });
});

describe("prune-db — lo que sí limpia", () => {
  it("vacía los payloads crudos viejos pero deja intactos los recientes", () => {
    seed().close();
    runPrune();
    const db = new Database(dbPath, { readonly: true });
    const stale = db
      .prepare("SELECT COUNT(*) n FROM observed_trades WHERE created_at < ? AND LENGTH(raw_trade_json) > 2")
      .get(ago(RETENTION.rawTradeJson)) as { n: number };
    expect(stale.n).toBe(0);
    const fresh = db
      .prepare("SELECT COUNT(*) n FROM observed_trades WHERE created_at >= ? AND LENGTH(raw_trade_json) > 2")
      .get(ago(RETENTION.rawTradeJson)) as { n: number };
    expect(fresh.n).toBeGreaterThan(0); // recent payloads still there
    db.close();
  });

  it("borra las señales observadas más viejas que la retención", () => {
    seed().close();
    runPrune();
    const db = new Database(dbPath, { readonly: true });
    const old = db.prepare("SELECT COUNT(*) n FROM observed_trades WHERE created_at < ?").get(ago(RETENTION.observedTrades)) as {
      n: number;
    };
    expect(old.n).toBe(0);
    expect(count(db, "observed_trades")).toBeGreaterThan(0); // but not a wipe
    db.close();
  });

  it("poda las capturas de precio y de PnL fuera de su ventana", () => {
    seed().close();
    runPrune();
    const db = new Database(dbPath, { readonly: true });
    const ms = db.prepare("SELECT COUNT(*) n FROM market_snapshots WHERE collected_at < ?").get(ago(RETENTION.marketSnapshots)) as {
      n: number;
    };
    const ps = db.prepare("SELECT COUNT(*) n FROM pnl_snapshots WHERE collected_at < ?").get(ago(RETENTION.pnlSnapshots)) as {
      n: number;
    };
    expect(ms.n).toBe(0);
    expect(ps.n).toBe(0);
    db.close();
  });

  it("con --force-vacuum achica el archivo de verdad — el arranque tras el disco lleno", () => {
    seed().close();
    const before = fs.statSync(dbPath).size;
    runPrune("--force-vacuum");
    expect(fs.statSync(dbPath).size).toBeLessThan(before);
  });

  it("sin forzar NO reescribe el archivo por poca ganancia — el corte diario no bloquea la base", () => {
    seed().close();
    const before = fs.statSync(dbPath).size;
    runPrune();
    // Rows are gone, but the file keeps its size: the free pages get reused.
    expect(fs.statSync(dbPath).size).toBe(before);
    const db = new Database(dbPath, { readonly: true });
    expect(count(db, "pnl_snapshots")).toBeLessThan(30);
    db.close();
  });
});

describe("prune-db — robustez en el arranque", () => {
  it("es idempotente: correrlo dos veces no rompe ni borra de más", () => {
    seed().close();
    runPrune();
    const db1 = new Database(dbPath, { readonly: true });
    const trades = count(db1, "paper_trades");
    const observed = count(db1, "observed_trades");
    db1.close();
    runPrune();
    const db2 = new Database(dbPath, { readonly: true });
    expect(count(db2, "paper_trades")).toBe(trades);
    expect(count(db2, "observed_trades")).toBe(observed);
    db2.close();
  });

  it("no revienta si la base todavía no existe — el arranque debe seguir", () => {
    expect(() => runPrune()).not.toThrow();
  });

  it("sobrevive a una base sin las tablas esperadas", () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE paper_trades (id TEXT PRIMARY KEY, opened_at INTEGER, realized_pnl REAL, track TEXT)");
    db.prepare("INSERT INTO paper_trades VALUES (?,?,?,?)").run("only", Date.now(), 1, "core");
    db.close();
    expect(() => runPrune()).not.toThrow();
    const check = new Database(dbPath, { readonly: true });
    expect(count(check, "paper_trades")).toBe(1);
    check.close();
  });
});
