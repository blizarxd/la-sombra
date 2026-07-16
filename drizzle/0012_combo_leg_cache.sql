CREATE TABLE `combo_leg_resolutions` (
	`question` text PRIMARY KEY NOT NULL,
	`end_date_ms` integer,
	`outcomes_json` text,
	`outcome_prices_json` text,
	`resolved_at` integer NOT NULL
);
