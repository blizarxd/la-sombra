-- The daily pick becomes a SHORTLIST: rank 1 is the pick of the day, ranks 2-4
-- are alternates, so a parlay can be built by hand from a vetted set.
--
-- The unique index moves from (pick_date) to (pick_date, rank). Immutability is
-- preserved per slot: today's #1 can never be re-chosen, and neither can its
-- alternates. That matters more than usual here — with four published picks,
-- "at least one of them won" is exactly the sleight of hand that makes a
-- tipster record meaningless, so rank 1 stays the only official record.
DROP INDEX `daily_picks_date_unique`;--> statement-breakpoint
ALTER TABLE `daily_picks` ADD `rank` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `daily_picks_date_rank_unique` ON `daily_picks` (`pick_date`,`rank`);
