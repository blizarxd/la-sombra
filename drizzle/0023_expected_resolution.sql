-- ⚡ Hours until the market's scheduled end, captured AT ENTRY (already
-- computed by the scorer for timing checks, just not persisted until now).
-- Forward-looking predictor for the fast-resolve finding in /matriz.
ALTER TABLE `paper_trades` ADD `expected_resolution_hours` real;
