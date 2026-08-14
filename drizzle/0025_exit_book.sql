-- 🚪 Exit book: forward-test of the exit-discipline finding. Following the
-- copied wallet out returned +39.1% across 10,381 settled copies while holding
-- to the oracle returned -7.8%. Implemented as an EXIT rule (never hold to
-- resolution) because "trades the wallet later sold" cannot be selected at
-- entry without reading the future.
CREATE TABLE `exit_book` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_trade_id` text NOT NULL,
	`source_track` text NOT NULL,
	`market_id` text NOT NULL,
	`market_question` text,
	`outcome` text,
	`category` text,
	`wallet_address` text,
	`arm_entry_price` real NOT NULL,
	`entry_price` real,
	`slippage_cents` real,
	`stake` real NOT NULL,
	`shares` real,
	`status` text DEFAULT 'open' NOT NULL,
	`skip_reason` text,
	`exit_reason` text,
	`held_hours` real,
	`arm_confluence` integer DEFAULT 1 NOT NULL,
	`realized_pnl` real,
	`capital_after` real,
	`opened_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exit_book_trade_unique` ON `exit_book` (`paper_trade_id`);--> statement-breakpoint
CREATE INDEX `exit_book_status_idx` ON `exit_book` (`status`);--> statement-breakpoint
CREATE INDEX `exit_book_opened_idx` ON `exit_book` (`opened_at`);
