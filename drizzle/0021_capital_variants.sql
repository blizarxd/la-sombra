-- 💰 Two bankrolls on the same signal stream (3 vs 5 concurrent) so the cost of
-- the cap is measured instead of argued, plus same-market dedup with the
-- confluence recorded rather than thrown away.
ALTER TABLE `capital_book` ADD `variant` text DEFAULT 'c3' NOT NULL;--> statement-breakpoint
ALTER TABLE `capital_book` ADD `arm_confluence` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Existing rows were decided under the OLD rule (no dedup: two arms copying one
-- market took two slots). Keeping them in the live books would mix two
-- different experiments in one ledger, so they are parked as legacy — kept for
-- the record, excluded from the comparison.
UPDATE `capital_book` SET `variant` = 'legacy-sin-dedup';--> statement-breakpoint
DROP INDEX IF EXISTS `capital_book_trade_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `capital_book_variant_trade_unique` ON `capital_book` (`variant`,`paper_trade_id`);
