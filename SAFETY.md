# SAFETY

**La Sombra is a research instrument, not a trading system. It is paper-only
by design, and this document explains why that is enforced in code — not just
promised in prose.** Nothing here is financial advice.

## Why v1 is paper-only

Copy trading looks deceptively easy: find profitable wallets, mirror their
trades. In practice most of the apparent edge evaporates on contact with
reality — you enter later and at worse prices than the wallet you copy, you
pay the spread twice, thin books can't absorb even small orders, and
leaderboards systematically overrepresent lucky gamblers. **The only honest
way to know whether an edge survives all of that is to simulate it with
brutal realism and measure.** That is what v1 does:

- paper buys fill against the **real ask side** of the live order book;
- positions are valued at the **bid** (what you could actually sell for);
- copies the book can't absorb are rejected as **unfillable** and tracked as
  a fill-rate metric, so results are not flattered by fantasy fills;
- extreme entries (ask above the entry-band ceiling, default 0.82) and late
  entries (price drifted more than the guard since the wallet's entry) are
  skipped, because those are exactly the trades that turn a leaderboard's
  profit into a copier's loss.

Only if weeks of paper trading show the bot-filtered strategy consistently
beating blind copying — after spreads, after fills, after fees-equivalent
slippage — does graduating to anything real even become a conversation.

## Why real execution is disabled (mechanically, not rhetorically)

- **No keys, ever.** The app never asks for, stores, or reads private keys,
  seed phrases, or trading API credentials. There is nothing to steal and
  nothing to misuse.
- **No signing code.** No wallet library (ethers/viem/web3) is installed;
  `package.json` is asserted clean by tests.
- **GET-only market data.** Every Polymarket adapter goes through a single
  `httpGet` wrapper that hard-codes the GET method. No adapter can POST.
- **One POST in the whole codebase:** Telegram notifications, and only to
  `api.telegram.org` — verified by the test suite.
- **Enforced by CI-grade tests.** `tests/safety.test.ts` scans the actual
  source tree on every `npm test` run and fails if anyone introduces key
  handling, signing, order endpoints, non-GET adapters, or a second POST.

## How autonomy could be added later (and what it would require)

The intended path, in order, with human judgment at each gate:

1. **Paper evidence** — several weeks of resolved paper trades where the
   bot-filtered strategy beats blind copying with a meaningful sample size
   and an honest fill rate.
2. **Shadow mode** — real-time signals logged next to real market outcomes,
   still zero execution.
3. **Segregated micro-capital** — if ever pursued, a separate signing service
   with its own keys and hard limits (per-trade cap, daily cap, kill switch),
   *never* keys inside this codebase; this app would at most emit signals to
   that service.
4. **Human-approved rule changes** — self-tuning is acceptable for paper; any
   system touching money must gate rule changes behind review.

None of that exists in v1, intentionally.

## Known risks of this kind of research (read before trusting any number)

- **Stale data:** public APIs lag; a "current" price may be seconds-to-minutes
  old. The bot stores real errors instead of faking data, but staleness can
  still flatter or punish results.
- **Low liquidity:** many Polymarket markets cannot absorb even $20 without
  moving; the fill simulator rejects those, but liquidity can also vanish
  between scoring and (hypothetical) execution.
- **Wide spreads:** the spread is a tax on every round trip; strategies that
  look profitable mid-to-mid often lose bid-to-ask.
- **Copy trading generally:** you always enter after the wallet you copy; in
  fast markets the edge belongs to whoever was first. Late copies are
  anti-selected toward the trades that already moved.
- **Misleading leaderboards:** 30-day PnL rankings are full of survivorship
  bias, one-hit wonders, martingale riders and volume farmers. The one-hit-
  wonder penalty and consistency scoring exist precisely because the raw
  leaderboard is not a list of skill.
- **Overfitting the rule tuner:** automatic threshold changes chase recent
  evidence; bounded steps and minimum sample sizes reduce, but do not
  eliminate, the risk of tuning to noise.

## Why private keys must never be stored here

A research bot that scrapes public data needs zero secrets; adding a key to
it converts every bug, dependency compromise, prompt-injection or laptop
theft into a **total loss of funds**. Key custody belongs in dedicated,
audited signing infrastructure with spending limits — never in a research
codebase that an agent edits automatically. That is why the safety tests
treat the *presence* of key-handling code as a failure, regardless of intent.
