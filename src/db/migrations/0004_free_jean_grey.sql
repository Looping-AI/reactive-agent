ALTER TABLE `scorecards` ADD `cookies_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `subtasks` ADD `params_json` text DEFAULT '{}' NOT NULL;