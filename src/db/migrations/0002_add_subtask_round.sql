CREATE TABLE `__new_subtasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`round` integer NOT NULL,
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
INSERT INTO `__new_subtasks`("id", "task_id", "round", "ordinal", "type", "recipe_id", "recipe_version", "prompt", "references_json", "depends_on_json", "status", "result_parts_json", "error", "created_at", "updated_at", "completed_at") SELECT "id", "task_id", 0, "ordinal", "type", "recipe_id", "recipe_version", "prompt", "references_json", "depends_on_json", "status", "result_parts_json", "error", "created_at", "updated_at", "completed_at" FROM `subtasks`;--> statement-breakpoint
DROP TABLE `subtasks`;--> statement-breakpoint
ALTER TABLE `__new_subtasks` RENAME TO `subtasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_subtasks_task_ordinal` ON `subtasks` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_task_round` ON `subtasks` (`task_id`,`round`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_status` ON `subtasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_created_at` ON `subtasks` (`created_at`);
