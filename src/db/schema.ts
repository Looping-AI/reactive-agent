import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Durable state for async A2A tasks (accept + notify lifecycle).
 *
 * One row per task: written by the Worker's accept path (`beginTask`, keyed by
 * `message_id` for gateway-dedup) and mutated by the `NotifyTaskWorkflow` via
 * DO RPC (`markWorking`, `completeTask`, `cancelTask`). `tasks/get` reads it
 * via `DurableTaskStore`. Table lives in the caller's DO SQLite (`this.ctx.storage`).
 */
export const notifyTasks = sqliteTable("notify_tasks", {
  taskId: text("task_id").primaryKey(),
  /** Gateway-assigned dedupe key — null for tasks created outside `beginTask`. */
  messageId: text("message_id").unique(),
  state: text("state").notNull(),
  taskJson: text("task_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const notifyTasksCreatedAtIdx = index("idx_notify_tasks_created_at").on(
  notifyTasks.createdAt
);
