-- ₿ Cripto book: crypto-only entries (the one filter with a positive floor),
-- priced honestly on BOTH sides — entry from the ask-side depth ladder, exit
-- by walking the recorded bid side for the real share count.
CREATE TABLE `cripto_book` (
	`id` text PRIMARY KEY NOT NULL,
	`paper_trade_id` text NOT NULL,
	`source_track` text NOT NULL,
	`market_id` text NOT NULL,
	`market_question` text,
	`outcome` text,
	`wallet_address` text,
	`arm_entry_price` real NOT NULL,
	`entry_price` real,
	`slippage_cents` real,
	`stake` real NOT NULL,
	`shares` real,
	`status` text DEFAULT 'open' NOT NULL,
	`skip_reason` text,
	`exit_reason` text,
	`exit_price` real,
	`exit_slippage_cents` real,
	`held_hours` real,
	`arm_confluence` integer DEFAULT 1 NOT NULL,
	`realized_pnl` real,
	`capital_after` real,
	`opened_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cripto_book_trade_unique` ON `cripto_book` (`paper_trade_id`);--> statement-breakpoint
CREATE INDEX `cripto_book_status_idx` ON `cripto_book` (`status`);--> statement-breakpoint
CREATE INDEX `cripto_book_opened_idx` ON `cripto_book` (`opened_at`);
