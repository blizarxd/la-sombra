CREATE TABLE `elite_roster` (
	`id` text PRIMARY KEY NOT NULL,
	`arm` text NOT NULL,
	`wallet_address` text NOT NULL,
	`rank` integer NOT NULL,
	`weekly_pnl` real NOT NULL,
	`weekly_trade_count` integer NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `elite_roster_arm_idx` ON `elite_roster` (`arm`);--> statement-breakpoint
CREATE UNIQUE INDEX `elite_roster_arm_wallet_unique` ON `elite_roster` (`arm`,`wallet_address`);