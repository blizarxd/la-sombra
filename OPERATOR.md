# OPERATOR

La Sombra is operated by a **Claude Code agent** driving npm scripts on a
schedule. This file is the operator's manual: the loop, the schedules, and
ready-to-use prompts.

> Everything here is paper trading. The operator may tune rules autonomously,
> but it can never trade, sign, or spend — there is no code path for it.

## The operating loop

| Cadence | Command | Purpose |
|---|---|---|
| daily (morning) | `npm run scan:leaderboard` | refresh the top-500 wallet list |
| daily, in chunks | `npm run scan:wallets -- --limit 25` | deep-profile stale/new wallets (batched to be polite to public APIs; ~34 batches covers 500 wallets over a few days, then it's incremental) |
| every 15–30 min | `npm run monitor:trades` | detect new trades from tracked wallets |
| every 15–30 min (after monitor) | `npm run score:trades` | score signals → journal decisions → open paper trades |
| hourly | `npm run paper:update-pnl` | mark open positions, settle resolved markets |
| every 6 h | `npm run review:outcomes` | judge past decisions, record lessons |
| daily (evening) | `npm run update:rules` | evidence-backed rule tuning + wallet downgrades |
| daily (end of day) | `npm run report:daily` | EOD report (DB + optional Telegram) |
| weekly / after incidents | `npm run verify:apis` and `npm test` | adapters still healthy, safety suite green |

Order matters within a tick: `monitor:trades` → `score:trades`.
All scripts are idempotent and safe to re-run; each ensures migrations first.

## Scheduling

### Windows Task Scheduler (this machine)

Create the tasks once from an elevated or normal PowerShell (adjust the repo
path if needed):

```powershell
$repo = "C:\Users\blizar\Desktop\la-sombra"
$npm  = (Get-Command npm.cmd).Source

# every 20 minutes: monitor + score
schtasks /Create /TN "LaSombra\monitor-score" /SC MINUTE /MO 20 `
  /TR "cmd /c cd /d $repo && $npm run monitor:trades && $npm run score:trades" /F

# hourly: paper pnl
schtasks /Create /TN "LaSombra\paper-pnl" /SC HOURLY /MO 1 `
  /TR "cmd /c cd /d $repo && $npm run paper:update-pnl" /F

# every 6 hours: outcome reviews
schtasks /Create /TN "LaSombra\reviews" /SC HOURLY /MO 6 `
  /TR "cmd /c cd /d $repo && $npm run review:outcomes" /F

# daily 08:00: leaderboard + a wallet batch
schtasks /Create /TN "LaSombra\morning-scan" /SC DAILY /ST 08:00 `
  /TR "cmd /c cd /d $repo && $npm run scan:leaderboard && $npm run scan:wallets -- --limit 25" /F

# daily 22:00: rules + report
schtasks /Create /TN "LaSombra\evening" /SC DAILY /ST 22:00 `
  /TR "cmd /c cd /d $repo && $npm run update:rules && $npm run report:daily" /F
```

Remove with `schtasks /Delete /TN "LaSombra\<name>" /F`.

### cron (Linux/macOS)

```cron
*/20 * * * *  cd /path/to/la-sombra && npm run monitor:trades && npm run score:trades >> logs/loop.log 2>&1
0 * * * *     cd /path/to/la-sombra && npm run paper:update-pnl              >> logs/pnl.log 2>&1
0 */6 * * *   cd /path/to/la-sombra && npm run review:outcomes               >> logs/reviews.log 2>&1
0 8 * * *     cd /path/to/la-sombra && npm run scan:leaderboard && npm run scan:wallets -- --limit 25 >> logs/scan.log 2>&1
0 22 * * *    cd /path/to/la-sombra && npm run update:rules && npm run report:daily >> logs/eod.log 2>&1
```

### Claude Code as the scheduler

Instead of raw cron, schedule a Claude Code session (cron'd `claude -p` or a
scheduled-tasks integration) with the prompts below — the agent then runs the
scripts, reads their output, and reacts (e.g. investigates a failing adapter
before it silently starves the pipeline).

## Agent prompts (copy-paste ready)

### 1. Routine tick (every 15–30 min)

```
You are the operator of La Sombra (paper-only Polymarket copy-trading research)
at C:\Users\blizar\Desktop\la-sombra. Run: `npm run monitor:trades` then
`npm run score:trades`. Read the output. If both succeeded, summarize in one
line (new signals / decisions split). If a script failed, read the real error:
for AdapterError (upstream API), retry once after a minute; if it still fails,
record the exact error and stop — never fake data, never edit adapters to
"work around" an error without understanding it. Do not touch rule thresholds
manually; that is update:rules' job. Never add trading, signing, or key code.
```

### 2. Hourly PnL

```
Operator of La Sombra (paper-only) at C:\Users\blizar\Desktop\la-sombra.
Run `npm run paper:update-pnl`. Report marked/resolved counts. If a specific
market repeatedly fails to mark (dead book), check whether it has resolved
via `npm run review:outcomes` and note it; leave real errors visible.
```

### 3. Daily morning scan

```
Operator of La Sombra (paper-only) at C:\Users\blizar\Desktop\la-sombra.
Run `npm run scan:leaderboard`, then `npm run scan:wallets -- --limit 25`.
Summarize: wallets returned, newly tracked/watched/ignored and why (the
script logs global scores and one-hit-wonder penalties). If the leaderboard
endpoint 404s or changes shape, capture the exact URL and error from the log,
then check whether the API moved (it moved to /v1/leaderboard once already) —
propose an adapter fix as a code change with the evidence, do not fabricate data.
```

### 4. Evening: self-improvement + report

```
Operator of La Sombra (paper-only) at C:\Users\blizar\Desktop\la-sombra.
Run `npm run update:rules`, then `npm run report:daily`. In your summary:
(1) every rule change with before -> after and the evidence line, (2) wallet
downgrades, (3) paper PnL today vs total, (4) whether bot-filtered beat blind
copy. Rule changes need no approval (paper only) but must never be silent:
they are versioned in the DB and shown on the /rules page — verify the new
version number appears. If update:rules proposes nothing for many days while
copies keep losing, investigate whether the evidence thresholds (MIN_SAMPLES)
are too strict and open a code-change proposal with data.
```

### 5. Weekly health check

```
Operator of La Sombra (paper-only) at C:\Users\blizar\Desktop\la-sombra.
Run `npm test` and `npm run verify:apis`. All 59 tests must pass — the safety
suite is non-negotiable; if it fails, something introduced a forbidden code
path: revert it. For verify:apis failures, record the actual HTTP errors and
investigate endpoint drift. Then read the last 7 daily reports from the
dashboard DB and write a weekly summary: PnL trend, fill rate, missed winners
vs avoided losers, rule-set version drift, and the single most valuable lesson
from outcome reviews.
```

### Operator guardrails (apply to every prompt)

- Paper only. Never add order submission, signing, or key handling — the
  safety tests will fail and the change must be reverted.
- Never fake data. An API error is a result; store it, surface it, stop.
- Rule changes only through `update:rules` so they are versioned and evidenced.
- Keep API usage polite: batched wallet scans, default limits.
- Secrets (Telegram token) come from `.env` only and are redacted in logs.

## Reading the system's state

- Dashboard: `npm run dev` → http://localhost:3000 (Overview answers the three
  questions; /rules shows every automatic change; /performance shows the
  bot-vs-blind benchmark).
- DB directly: `./data/la-sombra.db` (SQLite; tables documented in
  `src/db/schema.ts`).
- Logs: every script prints timestamped, secret-redacted lines and exits
  non-zero on failure, so schedulers can alert.
