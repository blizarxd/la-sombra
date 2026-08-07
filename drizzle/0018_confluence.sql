-- 🔗 Confluence: how many OTHER distinct tracked wallets had already bought the
-- same market+outcome within the window when this signal was scored.
--
-- Stored on the journal so it can be measured on EVERY signal (copies and
-- skips alike, the latter through their counterfactuals), and on the paper
-- trade so the matrices can slice by it. Computed looking strictly BACKWARD —
-- a confirmation that arrives later was not available at decision time, and
-- counting it would be reading the future.
ALTER TABLE `decision_journal` ADD `confluence_count` integer;--> statement-breakpoint
ALTER TABLE `paper_trades` ADD `confluence_count` integer;--> statement-breakpoint
-- The confluence lookup scans by market; without this it is a full table scan
-- on the largest table in the database.
CREATE INDEX IF NOT EXISTS `observed_trades_market_time_idx` ON `observed_trades` (`market_id`,`timestamp`);
