ALTER TABLE `observed_trades` ADD `in_play` integer;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `live_trade_count_30d` integer;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `live_resolved_count_30d` integer;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `live_win_rate_30d` real;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `live_roi_30d` real;