CREATE TABLE `__new_scorecards` (
	`card_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`cookies_json` text DEFAULT '{}' NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`summary_json` text,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_scorecards`("card_id", "status", "cookies_json", "opened_at", "closed_at", "summary_json", "last_used_at") SELECT "card_id", "status", "cookies_json", "opened_at", "closed_at", "summary_json", "opened_at" FROM `scorecards`;--> statement-breakpoint
DROP TABLE `scorecards`;--> statement-breakpoint
ALTER TABLE `__new_scorecards` RENAME TO `scorecards`;--> statement-breakpoint
CREATE INDEX `idx_scorecards_last_used_at` ON `scorecards` (`last_used_at`);
