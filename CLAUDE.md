# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Project: La Sombra

Polymarket copy-trading research bot. Next.js 15 + Drizzle/SQLite. **PAPER TRADING ONLY.**

**Safety (non-negotiable, do not re-derive — just follow):**
- No code path may ever submit a real order, sign a transaction, or handle a private key.
- If an API fails, show the real error and stop. Never fake/interpolate live data.
- Demo/seed data only when labeled `[DEMO]`.
- Secrets (Telegram token, Anthropic key) live in `.env` (gitignored), redacted in logs. Never asked for, never printed.

**Architecture (don't re-explore this — it's stable):**
- Three independent paper ledgers, same DB, separated by `paperTrades.track` (`"core" | "live" | "trade"`): `core` = pre-game hold + copy-exits, `live` = in-play, `trade` = quota-scalper round-trips. Each has its own self-tuning `ruleSets`/`ruleChanges` (`scope` matches `track`).
- Two observation desks (`/cripto`, `/cazador`) mine wallets directly from markets (`wallet_profiles.sources` tag) instead of the PnL leaderboard, because the leaderboard only surfaces holders. Qualifying wallets flow into the existing ledgers — these desks are not separate paper books.
- `operator-tick.ts` runs the full pipeline; a sourcing bootstrap self-heals a fresh deploy (checked per source tag, so one miner failing doesn't block the other).
- All timestamps: `APP_TZ = "America/Caracas"`.

**Commands:** `npm run dev` · `npm test` · `npm run db:migrate` (after any schema.ts change, then `npx drizzle-kit generate`) · `npm run operator:tick` (full pipeline, one shot).

**Deploy:** single Railway service (`la-sombra-production.up.railway.app`), SQLite on a volume, `git push` to `main` auto-deploys. Verify prod with `curl`/browser after every push that touches a page or the operator loop — don't assume the deploy landed.

**Before assuming project history/state:** check `C:\Users\blizar\.claude\projects\C--Users-blizar-Desktop-botpolym\memory\la-sombra-copytrading.md` first — it has dated entries with the actual reasoning behind past decisions. Don't re-derive from git log alone.
