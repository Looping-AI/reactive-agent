CREATE TABLE `scorecards` (
	`card_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`summary_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_scorecards_opened_at` ON `scorecards` (`opened_at`);