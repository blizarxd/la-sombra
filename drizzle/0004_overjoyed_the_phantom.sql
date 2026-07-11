CREATE TABLE `ai_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`data_cutoff` text,
	`summary` text NOT NULL,
	`likes_json` text,
	`dislikes_json` text,
	`recommendations_json` text,
	`applied_changes_json` text,
	`confidence` text,
	`tokens_input` integer,
	`tokens_output` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_analyses_created_idx` ON `ai_analyses` (`created_at`);