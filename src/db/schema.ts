import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * La Sombra database schema.
 *
 * SAFETY NOTE: this schema only stores RESEARCH data and SIMULATED (paper)
 * trades. There are no keys, no signatures, no orders — by design.
 */

// ---------------------------------------------------------------------------
// Leaderboard scans
// ---------------------------------------------------------------------------
export const leaderboardScans = sqliteTable("leaderboard_scans", {
  id: text("id").primaryKey(),
  source: text("source").notNull(), // e.g. "polymarket-data-api" | "demo-seed"
  scannedAt: integer("scanned_at", { mode: "timestamp_ms" }).notNull(),
  walletCount: integer("wallet_count").notNull(),
  lookbackDays: integer("lookback_days").notNull(),
  rawSummaryJson: text("raw_summary_json").notNull(),
});

// ---------------------------------------------------------------------------
// Wallet profiles
// ---------------------------------------------------------------------------
export const walletProfiles = sqliteTable(
  "wallet_profiles",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    label: text("label"),
    sourceRank: integer("source_rank"),
    status: text("status", { enum: ["track", "watch", "ignore"] })
      .notNull()
      .default("watch"),
    roi30d: real("roi_30d"),
    consistencyScore: real("consistency_score"),
    copyabilityScore: real("copyability_score"),
    oneHitWonderPenalty: real("one_hit_wonder_penalty"),
    globalScore: real("global_score"),
    bestCategory: text("best_category"),
    categoryStrengthsJson: text("category_strengths_json"),
    averageTradeSize: real("average_trade_size"),
    tradeCount30d: integer("trade_count_30d"),
    resolvedTradeCount30d: integer("resolved_trade_count_30d"),
    winRate30d: real("win_rate_30d"),
    // In-play (live) sub-metrics: the wallet's edge on trades placed after the
    // game/event start. null until profiled with game-start data.
    liveTradeCount30d: integer("live_trade_count_30d"),
    liveResolvedCount30d: integer("live_resolved_count_30d"),
    liveWinRate30d: real("live_win_rate_30d"),
    liveRoi30d: real("live_roi_30d"),
    // Quota-trader (swing) sub-metrics: does the wallet sell positions early,
    // trading the odds instead of holding to resolution — and profitably?
    sellCount30d: integer("sell_count_30d"),
    earlyExitRate: real("early_exit_rate"),
    swingPnl30d: real("swing_pnl_30d"),
    swingWinRate30d: real("swing_win_rate_30d"),
    tradingStyle: text("trading_style"), // "holdea" | "mixto" | "tradea_cuota"
    // Where the wallet was discovered: comma-separated tags, e.g. "pnl-board",
    // "crypto-market". Lets us mine scalper/crypto wallets the PnL board hides.
    sources: text("sources"),
    // 🧩 Combo (parlay) sub-profile: cashflow-honest stats over the wallet's
    // combo activity (data-api /activity, isCombo rows). Feeds the combo book's
    // eligibility gate. null until combo-profiled.
    comboBoardAppearances: integer("combo_board_appearances"), // times seen on the Combo Cup board
    comboLastBoardAt: integer("combo_last_board_at", { mode: "timestamp_ms" }),
    comboTradeCount30d: integer("combo_trade_count_30d"),
    comboRedeemCount30d: integer("combo_redeem_count_30d"),
    comboNetPnl30d: real("combo_net_pnl_30d"), // redeems + cashouts - stakes
    comboWinRate30d: real("combo_win_rate_30d"), // est.: redeems / mature buys
    comboLastProfiledAt: integer("combo_last_profiled_at", { mode: "timestamp_ms" }),
    averageLiquidity: real("average_liquidity"),
    averageSpread: real("average_spread"),
    averageEntryTiming: real("average_entry_timing"),
    copyabilityNotes: text("copyability_notes"),
    riskNotes: text("risk_notes"),
    // Sticky bench: once auto-downgraded for bleeding paper copies, the wallet
    // stays out even if its leaderboard score would re-promote it. Prevents the
    // downgrade<->reprofile oscillation that kept copying a losing wallet.
    benched: integer("benched", { mode: "boolean" }).notNull().default(false),
    lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("wallet_profiles_address_unique").on(t.address),
    index("wallet_profiles_status_idx").on(t.status),
    index("wallet_profiles_global_score_idx").on(t.globalScore),
  ],
);

// ---------------------------------------------------------------------------
// Observed trades (trades made by tracked wallets, detected by the monitor)
// ---------------------------------------------------------------------------
export const observedTrades = sqliteTable(
  "observed_trades",
  {
    id: text("id").primaryKey(),
    walletAddress: text("wallet_address").notNull(),
    marketId: text("market_id").notNull(),
    conditionId: text("condition_id"),
    tokenId: text("token_id"), // CLOB token id of the traded outcome (for pricing)
    marketQuestion: text("market_question"),
    marketCategory: text("market_category"),
    outcome: text("outcome"), // e.g. "Yes" | "No"
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    walletEntryPrice: real("wallet_entry_price").notNull(),
    detectedPrice: real("detected_price"),
    size: real("size").notNull(), // USD size of the wallet's trade
    inPlay: integer("in_play", { mode: "boolean" }), // null = unknown, set at scoring
    // (see paperTrades.track for how in-play copies are kept separate)
    timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    scored: integer("scored", { mode: "boolean" }).notNull().default(false),
    rawTradeJson: text("raw_trade_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("observed_trades_dedupe_unique").on(t.dedupeKey),
    index("observed_trades_wallet_idx").on(t.walletAddress),
    index("observed_trades_scored_idx").on(t.scored),
  ],
);

// ---------------------------------------------------------------------------
// Market snapshots
// ---------------------------------------------------------------------------
export const marketSnapshots = sqliteTable(
  "market_snapshots",
  {
    id: text("id").primaryKey(),
    marketId: text("market_id").notNull(),
    conditionId: text("condition_id"),
    question: text("question"),
    category: text("category"),
    yesPrice: real("yes_price"),
    noPrice: real("no_price"),
    bestBid: real("best_bid"),
    bestAsk: real("best_ask"),
    spread: real("spread"),
    liquidity: real("liquidity"),
    volume: real("volume"),
    timeToResolution: real("time_to_resolution"), // hours; null if unknown
    collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
    rawMarketJson: text("raw_market_json").notNull(),
  },
  (t) => [index("market_snapshots_market_idx").on(t.marketId, t.collectedAt)],
);

// ---------------------------------------------------------------------------
// Decision journal (every scored signal gets an entry)
// ---------------------------------------------------------------------------
export const decisionJournal = sqliteTable(
  "decision_journal",
  {
    id: text("id").primaryKey(),
    observedTradeId: text("observed_trade_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    marketId: text("market_id").notNull(),
    decision: text("decision", { enum: ["paper_copy", "watchlist", "skip"] }).notNull(),
    copyScore: real("copy_score").notNull(),
    confidence: real("confidence").notNull(),
    reasonsJson: text("reasons_json").notNull(),
    risksJson: text("risks_json").notNull(),
    walletQualityScore: real("wallet_quality_score"),
    roiScore: real("roi_score"),
    consistencyScore: real("consistency_score"),
    copyabilityScore: real("copyability_score"),
    categoryFitScore: real("category_fit_score"),
    entryTimingScore: real("entry_timing_score"),
    spreadScore: real("spread_score"),
    liquidityScore: real("liquidity_score"),
    thesisScore: real("thesis_score"),
    simulatedPositionSize: real("simulated_position_size"),
    // Skip autopsy: the PRIMARY gate that blocked this signal (null if copied).
    // Lets us measure which filter is leaking profitable signals vs blind copy.
    blockedGate: text("blocked_gate"),
    /**
     * 🔗 How many OTHER distinct tracked wallets had already bought this same
     * market+outcome inside the window when this signal was scored. Independent
     * confirmation is the one signal here that does not require trusting any
     * single wallet. Null on rows predating the instrumentation.
     */
    confluenceCount: integer("confluence_count"),
    ruleSetVersion: integer("rule_set_version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("decision_journal_decision_idx").on(t.decision),
    index("decision_journal_created_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Paper trades (SIMULATED only — never real)
// ---------------------------------------------------------------------------
export const paperTrades = sqliteTable(
  "paper_trades",
  {
    id: text("id").primaryKey(),
    decisionJournalId: text("decision_journal_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    marketId: text("market_id").notNull(),
    tokenId: text("token_id"),
    marketQuestion: text("market_question"),
    outcome: text("outcome"),
    side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
    entryPrice: real("entry_price").notNull(), // simulated fill (best ask for BUY)
    currentPrice: real("current_price"),
    simulatedPositionSize: real("simulated_position_size").notNull(), // USD, 5-20
    shares: real("shares").notNull(),
    spreadCostPaid: real("spread_cost_paid"), // cost vs mid at entry, tracked for realism
    unrealizedPnl: real("unrealized_pnl"),
    realizedPnl: real("realized_pnl"),
    status: text("status", { enum: ["open", "closed", "resolved"] })
      .notNull()
      .default("open"),
    // Which ledger this simulated position belongs to. "core" = the main
    // pre-game strategy; "live" = the parallel in-play experiment; "trade" =
    // the quota-trader book (copies buy->sell round-trips of odds-scalpers).
    // The ledgers NEVER mix: every core stat filters track='core'.
    track: text("track", { enum: ["core", "live", "trade", "crypto", "combo", "elite"] })
      .notNull()
      .default("core"),
    /**
     * 🏆 La Crema only: WHICH gold-cell rule let this copy in ("esports-barato"
     * or "banda-ventana"). Null for every other book AND for La Crema's copies
     * from before the 2026-07-18 rebuild, which is exactly what makes the old
     * failed top-10-wallet design separable from the new matrix-driven one.
     * Without it the ledger mixes two different experiments and the -$146
     * legacy hole buries whatever the new design is actually doing.
     */
    goldRule: text("gold_rule"),
    /**
     * 🎲 Opened by the EXPLORATION budget, not by an active gold cell. The
     * hybrid can only learn about cells it enters, so a small slice of copies
     * deliberately goes to the least-known ones. Kept separable so the price of
     * learning never gets read as the strategy's own performance.
     */
    exploratory: integer("exploratory", { mode: "boolean" }).notNull().default(false),
    /** 🔗 Confluence at entry — copied from the journal so matrices can slice it. */
    confluenceCount: integer("confluence_count"),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("paper_trades_status_idx").on(t.status),
    index("paper_trades_wallet_idx").on(t.walletAddress),
    index("paper_trades_track_idx").on(t.track),
  ],
);

// ---------------------------------------------------------------------------
// PnL snapshots (hourly marks for each paper trade)
// ---------------------------------------------------------------------------
export const pnlSnapshots = sqliteTable(
  "pnl_snapshots",
  {
    id: text("id").primaryKey(),
    paperTradeId: text("paper_trade_id").notNull(),
    price: real("price").notNull(),
    pnl: real("pnl").notNull(),
    collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("pnl_snapshots_trade_idx").on(t.paperTradeId, t.collectedAt)],
);

// ---------------------------------------------------------------------------
// Outcome reviews (was the decision good? what did we learn?)
// ---------------------------------------------------------------------------
export const outcomeReviews = sqliteTable(
  "outcome_reviews",
  {
    id: text("id").primaryKey(),
    decisionJournalId: text("decision_journal_id").notNull(),
    paperTradeId: text("paper_trade_id"),
    reviewTime: integer("review_time", { mode: "timestamp_ms" }).notNull(),
    priceAfter1h: real("price_after_1h"),
    priceAfter6h: real("price_after_6h"),
    priceAfter24h: real("price_after_24h"),
    finalOutcome: text("final_outcome"), // "won" | "lost" | "pending"
    simulatedPnl: real("simulated_pnl"),
    wasDecisionGood: integer("was_decision_good", { mode: "boolean" }),
    lessonsJson: text("lessons_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("outcome_reviews_decision_unique").on(t.decisionJournalId)],
);

// ---------------------------------------------------------------------------
// Rule sets (versioned, self-tuned)
// ---------------------------------------------------------------------------
export const ruleSets = sqliteTable(
  "rule_sets",
  {
    id: text("id").primaryKey(),
    // Independent rule lineages: "core" (main pre-game strategy), "live"
    // (the in-play experiment) and "trade" (the quota-trader book). Each
    // self-improves on its OWN evidence.
    scope: text("scope", { enum: ["core", "live", "trade", "crypto", "combo"] }).notNull().default("core"),
    version: integer("version").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    rulesJson: text("rules_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("rule_sets_scope_version_unique").on(t.scope, t.version)],
);

export const ruleChanges = sqliteTable("rule_changes", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["core", "live", "trade", "crypto", "combo"] }).notNull().default("core"),
  oldRuleSetId: text("old_rule_set_id"),
  newRuleSetId: text("new_rule_set_id").notNull(),
  changedBy: text("changed_by").notNull().default("agent"),
  reason: text("reason").notNull(),
  evidenceSummary: text("evidence_summary").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  expectedImprovement: text("expected_improvement"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------------------------------------------------------------------------
// AI analyst runs — the LLM expert's read of the data cutoff (recommendations
// by level, what it likes/dislikes, and any bounded changes it auto-applied).
// ---------------------------------------------------------------------------
export const aiAnalyses = sqliteTable(
  "ai_analyses",
  {
    id: text("id").primaryKey(),
    model: text("model").notNull(),
    dataCutoff: text("data_cutoff"), // human-readable description of the snapshot
    summary: text("summary").notNull(), // the expert narrative
    likesJson: text("likes_json"), // string[] — what it likes
    dislikesJson: text("dislikes_json"), // string[] — what it doesn't like
    recommendationsJson: text("recommendations_json"), // full recommendation objects (by level/scope)
    appliedChangesJson: text("applied_changes_json"), // bounded changes it auto-applied
    confidence: text("confidence"), // baja | media | alta
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("ai_analyses_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Daily reports
// ---------------------------------------------------------------------------
export const dailyReports = sqliteTable(
  "daily_reports",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(), // YYYY-MM-DD
    paperPnl: real("paper_pnl").notNull(),
    winRate: real("win_rate"),
    openPositions: integer("open_positions").notNull(),
    newSignals: integer("new_signals").notNull(),
    copiedSignals: integer("copied_signals").notNull(),
    watchedSignals: integer("watched_signals").notNull(),
    skippedSignals: integer("skipped_signals").notNull(),
    bestWalletsJson: text("best_wallets_json"),
    worstWalletsJson: text("worst_wallets_json"),
    ruleChangesJson: text("rule_changes_json"),
    summary: text("summary").notNull(),
    sentToTelegram: integer("sent_to_telegram", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("daily_reports_date_unique").on(t.date)],
);

// ---------------------------------------------------------------------------
// 🏆 Elite roster ("la crema") — the top-10-by-weekly-realized-PnL wallets per
// arm (core/live/trade/crypto), refreshed once a day. NOT a strategy of its
// own: it has no entry rules. It mirrors whatever an arm ALREADY decided to
// copy (that decision already passed that arm's own gates), adding exactly
// one extra filter — "is this wallet currently a confirmed weekly winner in
// its arm?" Wiped and rebuilt each refresh (see update-elite-roster.ts).
// ---------------------------------------------------------------------------
export const eliteRoster = sqliteTable(
  "elite_roster",
  {
    id: text("id").primaryKey(),
    arm: text("arm", { enum: ["core", "live", "trade", "crypto"] }).notNull(),
    walletAddress: text("wallet_address").notNull(),
    rank: integer("rank").notNull(), // 1 = best this week
    weeklyPnl: real("weekly_pnl").notNull(),
    weeklyTradeCount: integer("weekly_trade_count").notNull(),
    computedAt: integer("computed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("elite_roster_arm_idx").on(t.arm),
    uniqueIndex("elite_roster_arm_wallet_unique").on(t.arm, t.walletAddress),
  ],
);

// ---------------------------------------------------------------------------
// Control settings (single row) — manual switches over the paper experiments.
// SAFETY: paper trading only. These flags gate whether SIMULATED copies open;
// no flag here can ever place a real order.
// ---------------------------------------------------------------------------
export const controlSettings = sqliteTable("control_settings", {
  id: text("id").primaryKey(), // always "singleton"
  liveEnabled: integer("live_enabled", { mode: "boolean" }).notNull().default(true),
  liveStakeUsd: real("live_stake_usd").notNull().default(5),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 🧩 Permanent cache of a combo LEG's resolution (added 2026-07-16).
 *
 * Settling a combo means checking every leg against its real market. Without a
 * durable cache, combo-tick re-fetched the SAME legs from gamma every 20-minute
 * tick forever — so a per-tick lookup budget got burned on games that finished
 * days ago, and combos at the back of the queue were never evaluated at all.
 * A leg that is closed + uma-resolved is FINAL, so it is written here once and
 * never fetched again; only still-open legs cost a call. That is what lets the
 * book hold many more open combos without settlement falling behind.
 */
/**
 * 🧬 La Crema's auto-evolving gold cells (added 2026-07-20).
 *
 * Each row is ONE matrix cell (e.g. "hour:08" or "cat-band:esports:p00") that
 * the daily gold scan is tracking. kind="gold" cells let a trade INTO the
 * hybrid; kind="trap" cells VETO it (traps win). Lifecycle is hysteresis-based
 * and pre-registered so nobody improvises with the result in view:
 * candidata → activa after 2 consecutive scans as a survivor; activa → retirada
 * after 2 consecutive scans failing. The scan itself only READS settled paper
 * trades — this table steers which paper copies La Crema mirrors, nothing else.
 */
export const cremaCells = sqliteTable(
  "crema_cells",
  {
    id: text("id").primaryKey(), // canonical cell id, e.g. "hour:08"
    kind: text("kind", { enum: ["gold", "trap"] }).notNull(),
    label: text("label").notNull(),
    paramsJson: text("params_json").notNull(), // serialized CellParams (arm/category/hourBlock/priceBand)
    status: text("status", { enum: ["sospecha", "candidata", "activa", "retirada"] }).notNull(),
    hits: integer("hits").notNull().default(0), // consecutive scans as survivor
    misses: integer("misses").notNull().default(0), // consecutive scans failing
    evidenceJson: text("evidence_json"), // latest per-window stats, for the UI
    // "real" = settled paper copies; "shadow" = counterfactual outcomes of the
    // signals we declined. Shadow cells nominate; only real evidence activates.
    evidenceSource: text("evidence_source", { enum: ["real", "shadow"] }).notNull().default("real"),
    realN: integer("real_n").notNull().default(0), // settled REAL copies behind the cell
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("crema_cells_status_idx").on(t.status)],
);

/** Append-only log of every cell transition — the strategy's own diary. */
export const cremaEvolution = sqliteTable(
  "crema_evolution",
  {
    id: text("id").primaryKey(),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    cellId: text("cell_id").notNull(),
    action: text("action").notNull(), // candidata | activada | podada | reactivada | descartada | semilla
    detail: text("detail").notNull(),
  },
  (t) => [index("crema_evolution_at_idx").on(t.at)],
);

// ---------------------------------------------------------------------------
// 🎯 Daily pick — the public, falsifiable track record
// ---------------------------------------------------------------------------
/**
 * ONE pick per day, frozen at publication with the price you would actually
 * pay. Immutable: the unique index on pickDate makes re-picking impossible,
 * which is the single mechanism that separates a real record from a laundered
 * one. Still paper — this records a claim, it never places an order.
 */
export const dailyPicks = sqliteTable(
  "daily_picks",
  {
    id: text("id").primaryKey(),
    pickDate: text("pick_date").notNull(), // YYYY-MM-DD in APP_TZ
    /**
     * 1 = the pick of the day (the ONLY one that counts toward the official
     * record). 2-4 = vetted alternates, published so a parlay can be built by
     * hand. Scoring all four together would turn the record into "at least one
     * of our picks won", which is precisely how a tipster record is laundered.
     */
    rank: integer("rank").notNull().default(1),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    marketId: text("market_id").notNull(),
    tokenId: text("token_id"),
    marketQuestion: text("market_question"),
    outcome: text("outcome"),
    /** Best ASK at publication — what it would cost, spread included. */
    entryPrice: real("entry_price").notNull(),
    bestBid: real("best_bid"),
    spread: real("spread"),
    cellId: text("cell_id"),
    cellLabel: text("cell_label"),
    copyScore: real("copy_score"),
    confidence: real("confidence"),
    walletAddress: text("wallet_address"),
    category: text("category"),
    reasoning: text("reasoning").notNull(),
    status: text("status", { enum: ["abierto", "ganado", "perdido", "anulado"] })
      .notNull()
      .default("abierto"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /** Result on a fixed $10 unit, so every day is comparable. */
    pnlPer10: real("pnl_per10"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("daily_picks_date_rank_unique").on(t.pickDate, t.rank),
    index("daily_picks_status_idx").on(t.status),
  ],
);

export const comboLegResolutions = sqliteTable("combo_leg_resolutions", {
  /** The leg's exact question text, lowercased — that is how combo titles key it. */
  question: text("question").primaryKey(),
  endDateMs: integer("end_date_ms"),
  /** Raw gamma arrays, kept verbatim so the verdict logic stays in one place. */
  outcomesJson: text("outcomes_json"),
  outcomePricesJson: text("outcome_prices_json"),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }).notNull(),
});
