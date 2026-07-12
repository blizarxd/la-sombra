CREATE TABLE `control_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`live_enabled` integer DEFAULT true NOT NULL,
	`live_stake_usd` real DEFAULT 5 NOT NULL,
	`updated_at` integer NOT NULL
);
