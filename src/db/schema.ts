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
    averageLiquidity: real("average_liquidity"),
    averageSpread: real("average_spread"),
    averageEntryTiming: real("average_entry_timing"),
    copyabilityNotes: text("copyability_notes"),
    riskNotes: text("risk_notes"),
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
    // pre-game strategy; "live" = the parallel in-play experiment. The two
    // ledgers NEVER mix: every core stat filters track='core'.
    track: text("track", { enum: ["core", "live"] })
      .notNull()
      .default("core"),
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
    // Independent rule lineages: "core" (main pre-game strategy) and "live"
    // (the in-play experiment). Each self-improves on its OWN evidence.
    scope: text("scope", { enum: ["core", "live"] }).notNull().default("core"),
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
  scope: text("scope", { enum: ["core", "live"] }).notNull().default("core"),
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
