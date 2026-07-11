DROP INDEX `rule_sets_version_unique`;--> statement-breakpoint
ALTER TABLE `rule_sets` ADD `scope` text DEFAULT 'core' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rule_sets_scope_version_unique` ON `rule_sets` (`scope`,`version`);--> statement-breakpoint
ALTER TABLE `rule_changes` ADD `scope` text DEFAULT 'core' NOT NULL;