ALTER TABLE `paper_trades` ADD `track` text DEFAULT 'core' NOT NULL;--> statement-breakpoint
CREATE INDEX `paper_trades_track_idx` ON `paper_trades` (`track`);