# La Sombra

Self-improving **Polymarket copy-trading research bot** with a Next.js dashboard,
operated by a Claude Code agent loop.

> **PAPER TRADING ONLY. This is not financial advice.**
> La Sombra never places real trades, never touches money, and has **no code
> path that can submit an order**. See [SAFETY.md](./SAFETY.md).

## What it does

1. Pulls the Polymarket 30-day PnL **leaderboard** (top 500 wallets).
2. **Deep-profiles** each wallet: 30d ROI, consistency, copyability, category
   strengths, and a **one-hit-wonder penalty** for wallets whose profit came
   from a single lucky trade.
3. **Tracks** the wallets worth following and detects their new trades.
4. **Scores every signal** against live market conditions (entry band, price
   drift since the wallet's entry, spread, liquidity, time to resolution,
   wallet quality) and decides: `paper_copy`, `watchlist`, or `skip`.
5. **Paper-copies** the strong signals with $5–$20 simulated positions
   (higher confidence → larger size), filling realistically against the real
   order book: buys walk the ask side, exits are valued at the bid, and trades
   the book can't absorb are marked **unfillable** and not opened.
6. Updates **paper PnL hourly** and settles positions when markets resolve.
7. **Reviews its own decisions** (+1h/+6h/+24h prices, final outcome, was the
   decision good, what's the lesson).
8. **Improves its own rules** automatically — bounded threshold changes backed
   by resolved evidence, fully versioned with reason / evidence / before / after.
9. Benchmarks itself against **blindly copying the leaderboard** and tracks
   missed winners, avoided losers, bad copies and good skips.
10. Writes an **end-of-day report** (stored in the DB; sent to Telegram only if
    configured).

## What it does NOT do

- It does **not** place real orders — there is no order-submission code at all.
- It does **not** ask for, store, or use private keys, seed phrases, or API
  credentials for trading.
- It does **not** sign anything or spend anything.
- It does **not** fake data: if an upstream API fails, the real error is
  logged and the run stops.

## Stack

TypeScript · Next.js 15 (App Router, server components) · React 19 ·
Tailwind CSS 4 · Drizzle ORM · SQLite (better-sqlite3) · tsx · Vitest.
No paid services required.

## Setup

```bash
npm install
npm run db:migrate     # creates ./data/la-sombra.db and applies migrations
npm run seed           # rule set v1 + clearly-labeled [DEMO] preview data
```

Optional environment variables (copy `.env.example` to `.env`):

| Variable | Purpose |
|---|---|
| `DATABASE_PATH` | SQLite file location (default `./data/la-sombra.db`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | enable Telegram reports/alerts (both required) |
| `POLYMARKET_DATA_API` / `POLYMARKET_GAMMA_API` / `POLYMARKET_CLOB_API` | override public API base URLs |
| `LEADERBOARD_SCAN_LIMIT` | wallets per leaderboard scan (default 500) |

Secrets are redacted in logs and never shown in the UI.

## Run locally

```bash
npm run dev            # dashboard at http://localhost:3000
```

The research loop (see [OPERATOR.md](./OPERATOR.md) for scheduling):

```bash
npm run scan:leaderboard   # top-500 leaderboard -> wallet_profiles skeletons
npm run scan:wallets       # deep-profile a batch (default 15; -- --limit N)
npm run monitor:trades     # detect new trades from tracked wallets
npm run score:trades       # score signals, journal decisions, open paper trades
npm run paper:update-pnl   # hourly marks + resolution settlement
npm run review:outcomes    # judge past decisions, write lessons
npm run update:rules       # self-improvement (versioned, evidence-backed)
npm run report:daily       # EOD report (DB + optional Telegram)
npm run verify:apis        # one-shot live check of all adapters
npm test                   # 59 tests incl. read-only safety suite
```

## How the pieces work

### Leaderboard scan & wallet scoring
`scan:leaderboard` pages `data-api.polymarket.com/v1/leaderboard` (50 rows per
page) up to 500 wallets. `scan:wallets` then pulls each wallet's 30d trade
history, resolves market outcomes via the CLOB metadata endpoint (explicit
`winner` flags), and computes:

- **ROI score** — 30d profit over cost basis;
- **Consistency** — profitable weeks + how spread out the profit is (HHI);
- **Copyability** — liquidity, spreads, post-entry drift, entry-price band,
  history depth: can a follower realistically replicate the entries?
- **One-hit-wonder penalty** — share of total profit from the single best
  trade above a threshold (default 50%) maps to a 0–100 penalty;
- **Category edge** — the wallet's best category with win rates per category.

The weighted global score sets the status: `track` / `watch` / `ignore`,
always with a written reason.

### Trade scoring & paper trading
Signals from tracked wallets pass hard gates first (entry band ≤ 0.82 by
default, late-entry drift guard, max spread, min liquidity, resolution window,
min wallet score; SELLs are exit information, not copyable entries in v1).
Surviving signals get a weighted 0–100 copy score → decision + position size.
Paper fills walk the real ask side and pay the spread; unfillable copies are
recorded for the **fill-rate realism metric** but never opened.

### Self-improvement
`update:rules` looks only at **resolved** evidence (settled paper trades +
outcome reviews) and makes small bounded changes: tighten `maxSpread` when
spread-heavy copies lose, tighten the drift guard when late entries lose,
raise `minLiquidity` when thin markets lose, tune the copy threshold from win
rate vs missed winners, lower the entry-band ceiling when expensive entries
lose, and shift weight from ROI to consistency when hot-streak wallets
disappoint. Every change creates a **new rule set version** plus a
`rule_changes` row: what, why, evidence, before, after, expected improvement.
Wallets with repeatedly losing copies are auto-downgraded (noted on their
profile).

## Reading the dashboard

| Page | Answers |
|---|---|
| **Overview** | Are we profitable on paper? Which wallets? What changed today? |
| **Wallet Rankings** | Top-500 scan with scores, penalty, status + reason |
| **Wallet Profile** | Copyable or not (and why), category strengths, paper PnL if copied |
| **Trade Signals** | Every detected trade with market context and the decision |
| **Paper Trades** | Simulated positions, hourly PnL, fill-rate realism, spread cost |
| **Decision Journal** | Full score breakdown per decision + later verdict and lesson |
| **Performance** | Bot-filtered vs blind copy, missed winners / avoided losers |
| **Rules** | Active thresholds, every automatic change, full version history |
| **Reports** | EOD reports with best/worst wallets and rule updates |

Anything created by `npm run seed` is tagged **[DEMO]** in the data and shown
with a demo badge in the UI — demo and real data are never mixed silently.

## Deploy to Vercel

The dashboard is Vercel-ready (App Router, dynamic server rendering), but
**SQLite lives on your machine** — serverless functions have no persistent
disk. Two supported patterns:

1. **Local-first (recommended for v1):** run the dashboard + loop locally or
   on any small VM/NAS; nothing to deploy.
2. **Vercel + hosted SQLite:** move the DB to a hosted libSQL/Turso instance,
   swap `drizzle-orm/better-sqlite3` for `drizzle-orm/libsql` in
   `src/db/client.ts` (schema and queries are unchanged), set the connection
   env vars in Vercel, and keep running the operator scripts anywhere with
   write access to that DB. Then: `vercel deploy` (build command `next build`
   works as-is).

The adapter layer and all queries are already isolated, so the swap touches
one file.

## Operator

The system is designed to be **driven by a Claude Code agent** through the
npm scripts above — see [OPERATOR.md](./OPERATOR.md) for the loop, Windows
Task Scheduler / cron examples, and ready-to-use agent prompts.
