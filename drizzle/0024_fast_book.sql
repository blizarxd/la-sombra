-- ⚡ Fast book: forward-test of the duration finding (/matriz shows <1h
-- resolve at +$473.78 total vs -$1275.60 for 1-6h; esports <1h at +17.9%).
-- Same discipline as capital_book: one bankroll, flat stake, dedup, priced off
-- the measured depth ladder.
CREATE TABLE `fast_book` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_trade_id` text NOT NULL,
	`source_track` text NOT NULL,
	`market_id` text NOT NULL,
	`market_question` text,
	`outcome` text,
	`category` text,
	`expected_resolution_hours` real,
	`arm_entry_price` real NOT NULL,
	`entry_price` real,
	`slippage_cents` real,
	`stake` real NOT NULL,
	`shares` real,
	`status` text DEFAULT 'open' NOT NULL,
	`skip_reason` text,
	`exit_reason` text,
	`arm_confluence` integer DEFAULT 1 NOT NULL,
	`realized_pnl` real,
	`capital_after` real,
	`opened_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fast_book_trade_unique` ON `fast_book` (`paper_trade_id`);--> statement-breakpoint
CREATE INDEX `fast_book_status_idx` ON `fast_book` (`status`);--> statement-breakpoint
CREATE INDEX `fast_book_opened_idx` ON `fast_book` (`opened_at`);
