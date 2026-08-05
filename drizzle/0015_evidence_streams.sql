-- Which evidence stream a cell qualified on: "real" (settled paper copies) or
-- "shadow" (counterfactual outcomes of signals we declined). A shadow cell is a
-- SUSPICION and can never activate on its own — it has no fill realism.
ALTER TABLE `crema_cells` ADD `evidence_source` text DEFAULT 'real' NOT NULL;--> statement-breakpoint
-- How many settled REAL copies the cell has behind it. Activation needs this,
-- not the shadow count, otherwise the hybrid would trade on arithmetic alone.
ALTER TABLE `crema_cells` ADD `real_n` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Marks a copy opened by the exploration budget rather than by a gold cell.
-- Keeps the cost of learning separable from the strategy's own performance.
ALTER TABLE `paper_trades` ADD `exploratory` integer DEFAULT false NOT NULL;
