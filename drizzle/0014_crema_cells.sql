CREATE TABLE `crema_cells` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`misses` integer DEFAULT 0 NOT NULL,
	`evidence_json` text,
	`first_seen_at` integer NOT NULL,
	`activated_at` integer,
	`retired_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crema_cells_status_idx` ON `crema_cells` (`status`);
--> statement-breakpoint
CREATE TABLE `crema_evolution` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`cell_id` text NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crema_evolution_at_idx` ON `crema_evolution` (`at`);
