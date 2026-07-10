CREATE TABLE `daily_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`paper_pnl` real NOT NULL,
	`win_rate` real,
	`open_positions` integer NOT NULL,
	`new_signals` integer NOT NULL,
	`copied_signals` integer NOT NULL,
	`watched_signals` integer NOT NULL,
	`skipped_signals` integer NOT NULL,
	`best_wallets_json` text,
	`worst_wallets_json` text,
	`rule_changes_json` text,
	`summary` text NOT NULL,
	`sent_to_telegram` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_reports_date_unique` ON `daily_reports` (`date`);--> statement-breakpoint
CREATE TABLE `decision_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_trade_id` text NOT NULL,
	`wallet_address` text NOT NULL,
	`market_id` text NOT NULL,
	`decision` text NOT NULL,
	`copy_score` real NOT NULL,
	`confidence` real NOT NULL,
	`reasons_json` text NOT NULL,
	`risks_json` text NOT NULL,
	`wallet_quality_score` real,
	`roi_score` real,
	`consistency_score` real,
	`copyability_score` real,
	`category_fit_score` real,
	`entry_timing_score` real,
	`spread_score` real,
	`liquidity_score` real,
	`thesis_score` real,
	`simulated_position_size` real,
	`rule_set_version` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decision_journal_decision_idx` ON `decision_journal` (`decision`);--> statement-breakpoint
CREATE INDEX `decision_journal_created_idx` ON `decision_journal` (`created_at`);--> statement-breakpoint
CREATE TABLE `leaderboard_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`scanned_at` integer NOT NULL,
	`wallet_count` integer NOT NULL,
	`lookback_days` integer NOT NULL,
	`raw_summary_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`market_id` text NOT NULL,
	`condition_id` text,
	`question` text,
	`category` text,
	`yes_price` real,
	`no_price` real,
	`best_bid` real,
	`best_ask` real,
	`spread` real,
	`liquidity` real,
	`volume` real,
	`time_to_resolution` real,
	`collected_at` integer NOT NULL,
	`raw_market_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `market_snapshots_market_idx` ON `market_snapshots` (`market_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `observed_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_address` text NOT NULL,
	`market_id` text NOT NULL,
	`condition_id` text,
	`token_id` text,
	`market_question` text,
	`market_category` text,
	`outcome` text,
	`side` text NOT NULL,
	`wallet_entry_price` real NOT NULL,
	`detected_price` real,
	`size` real NOT NULL,
	`timestamp` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`scored` integer DEFAULT false NOT NULL,
	`raw_trade_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observed_trades_dedupe_unique` ON `observed_trades` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `observed_trades_wallet_idx` ON `observed_trades` (`wallet_address`);--> statement-breakpoint
CREATE INDEX `observed_trades_scored_idx` ON `observed_trades` (`scored`);--> statement-breakpoint
CREATE TABLE `outcome_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_journal_id` text NOT NULL,
	`paper_trade_id` text,
	`review_time` integer NOT NULL,
	`price_after_1h` real,
	`price_after_6h` real,
	`price_after_24h` real,
	`final_outcome` text,
	`simulated_pnl` real,
	`was_decision_good` integer,
	`lessons_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outcome_reviews_decision_unique` ON `outcome_reviews` (`decision_journal_id`);--> statement-breakpoint
CREATE TABLE `paper_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_journal_id` text NOT NULL,
	`wallet_address` text NOT NULL,
	`market_id` text NOT NULL,
	`token_id` text,
	`market_question` text,
	`outcome` text,
	`side` text NOT NULL,
	`entry_price` real NOT NULL,
	`current_price` real,
	`simulated_position_size` real NOT NULL,
	`shares` real NOT NULL,
	`spread_cost_paid` real,
	`unrealized_pnl` real,
	`realized_pnl` real,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `paper_trades_status_idx` ON `paper_trades` (`status`);--> statement-breakpoint
CREATE INDEX `paper_trades_wallet_idx` ON `paper_trades` (`wallet_address`);--> statement-breakpoint
CREATE TABLE `pnl_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_trade_id` text NOT NULL,
	`price` real NOT NULL,
	`pnl` real NOT NULL,
	`collected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pnl_snapshots_trade_idx` ON `pnl_snapshots` (`paper_trade_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `rule_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`old_rule_set_id` text,
	`new_rule_set_id` text NOT NULL,
	`changed_by` text DEFAULT 'agent' NOT NULL,
	`reason` text NOT NULL,
	`evidence_summary` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`expected_improvement` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rule_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`rules_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_sets_version_unique` ON `rule_sets` (`version`);--> statement-breakpoint
CREATE TABLE `wallet_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`label` text,
	`source_rank` integer,
	`status` text DEFAULT 'watch' NOT NULL,
	`roi_30d` real,
	`consistency_score` real,
	`copyability_score` real,
	`one_hit_wonder_penalty` real,
	`global_score` real,
	`best_category` text,
	`category_strengths_json` text,
	`average_trade_size` real,
	`trade_count_30d` integer,
	`resolved_trade_count_30d` integer,
	`win_rate_30d` real,
	`average_liquidity` real,
	`average_spread` real,
	`average_entry_timing` real,
	`copyability_notes` text,
	`risk_notes` text,
	`last_scanned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_profiles_address_unique` ON `wallet_profiles` (`address`);--> statement-breakpoint
CREATE INDEX `wallet_profiles_status_idx` ON `wallet_profiles` (`status`);--> statement-breakpoint
CREATE INDEX `wallet_profiles_global_score_idx` ON `wallet_profiles` (`global_score`);