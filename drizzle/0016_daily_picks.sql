-- 🎯 El Pick del Día — one frozen selection per day, immutable once written.
--
-- The unique index on pick_date is the whole point: a pick can never be
-- re-chosen after the fact, which is exactly how a tipster's record gets
-- quietly laundered. Entry price and published_at are stamped at selection
-- time, BEFORE the outcome is known, so every claim is falsifiable.
CREATE TABLE `daily_picks` (
	`id` text PRIMARY KEY NOT NULL,
	`pick_date` text NOT NULL,
	`published_at` integer NOT NULL,
	`market_id` text NOT NULL,
	`token_id` text,
	`market_question` text,
	`outcome` text,
	-- What you would ACTUALLY pay (best ask), never the mid. Paying the spread
	-- is the difference between a real track record and a flattering one.
	`entry_price` real NOT NULL,
	`best_bid` real,
	`spread` real,
	`cell_id` text,
	`cell_label` text,
	`copy_score` real,
	`confidence` real,
	`wallet_address` text,
	`category` text,
	`reasoning` text NOT NULL,
	`status` text DEFAULT 'abierto' NOT NULL,
	`resolved_at` integer,
	-- Result on a fixed $10 unit, so days are comparable to each other.
	`pnl_per10` real,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_picks_date_unique` ON `daily_picks` (`pick_date`);--> statement-breakpoint
CREATE INDEX `daily_picks_status_idx` ON `daily_picks` (`status`);
