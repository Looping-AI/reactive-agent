CREATE TABLE `notify_tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`state` text NOT NULL,
	`task_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notify_tasks_message_id_unique` ON `notify_tasks` (`message_id`);
--> statement-breakpoint
CREATE INDEX `idx_notify_tasks_created_at` ON `notify_tasks` (`created_at`);
