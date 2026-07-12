ALTER TABLE `wallet_profiles` ADD `sell_count_30d` integer;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `early_exit_rate` real;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `swing_pnl_30d` real;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `swing_win_rate_30d` real;--> statement-breakpoint
ALTER TABLE `wallet_profiles` ADD `trading_style` text;