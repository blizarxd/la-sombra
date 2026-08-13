-- 💰 Capital book: one simulated bankroll with hard rules (fixed capital, flat
-- stake, max concurrent positions), mirroring qualifying arm copies and priced
-- at the measured fill for the real stake. Skipped signals are recorded too, so
-- the cost of the concurrency cap is visible instead of invisible.
CREATE TABLE `capital_book` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_trade_id` text NOT NULL,
	`source_track` text NOT NULL,
	`market_id` text NOT NULL,
	`market_question` text,
	`outcome` text,
	`category` text,
	`arm_entry_price` real NOT NULL,
	`entry_price` real,
	`slippage_cents` real,
	`stake` real NOT NULL,
	`shares` real,
	`status` text DEFAULT 'open' NOT NULL,
	`skip_reason` text,
	`realized_pnl` real,
	`capital_after` real,
	`opened_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capital_book_trade_unique` ON `capital_book` (`paper_trade_id`);--> statement-breakpoint
CREATE INDEX `capital_book_status_idx` ON `capital_book` (`status`);--> statement-breakpoint
CREATE INDEX `capital_book_opened_idx` ON `capital_book` (`opened_at`);
