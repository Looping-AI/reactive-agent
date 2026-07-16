CREATE TABLE `subtasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`type` text NOT NULL,
	`recipe_id` text,
	`recipe_version` integer,
	`prompt` text NOT NULL,
	`references_json` text NOT NULL,
	`depends_on_json` text NOT NULL,
	`status` text NOT NULL,
	`result_parts_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_subtasks_task_ordinal` ON `subtasks` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_status` ON `subtasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_created_at` ON `subtasks` (`created_at`);