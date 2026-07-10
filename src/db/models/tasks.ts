import type { Task } from "@a2a-js/sdk";
import { eq, lt } from "drizzle-orm";
import type { PlainTask } from "@/a2a/task";
import { buildSubmittedTask } from "@/a2a/notify";
import { notifyTasks } from "@/db/schema";
import type { DB } from "@/db/db";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Query methods for the `notify_tasks` table (async A2A task state).
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as `db.tasks.*`.
 * Migrations are owned by `AgentDB`, not this factory — it only issues queries.
 */
export function makeTasks(db: DB) {
  const parse = (row: { taskJson: string }): PlainTask =>
    JSON.parse(row.taskJson) as PlainTask;

  const readOne = (taskId: string): PlainTask | null => {
    const row = db
      .select()
      .from(notifyTasks)
      .where(eq(notifyTasks.taskId, taskId))
      .get();
    return row ? parse(row) : null;
  };

  const upsert = (task: Task): void => {
    db.insert(notifyTasks)
      .values({
        taskId: task.id,
        messageId: null,
        state: task.status.state,
        taskJson: JSON.stringify(task),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .onConflictDoUpdate({
        target: notifyTasks.taskId,
        set: {
          state: task.status.state,
          taskJson: JSON.stringify(task),
          updatedAt: Date.now()
        }
      })
      .run();
  };

  return {
    /**
     * Accept a turn: return the `submitted` Task for the given `messageId`,
     * creating it on first sight. Idempotent on `messageId` (the gateway's
     * dedupe key, stable across dispatch retries).
     */
    begin(input: {
      messageId: string;
      taskId: string;
      contextId: string;
    }): PlainTask {
      const existing = db
        .select()
        .from(notifyTasks)
        .where(eq(notifyTasks.messageId, input.messageId))
        .get();
      if (existing) return parse(existing);

      const task = buildSubmittedTask(input.taskId, input.contextId);
      db.insert(notifyTasks)
        .values({
          taskId: task.id,
          messageId: input.messageId,
          state: task.status.state,
          taskJson: JSON.stringify(task),
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
        .run();
      return task;
    },

    /** Load a task by id (for `tasks/get` via the Worker's `DurableTaskStore`). */
    get(taskId: string): PlainTask | null {
      return readOne(taskId);
    },

    /** Upsert a task by id. Preserves the `message_id` set by {@link begin}. */
    save(task: Task): void {
      upsert(task);
    },

    /** Move a task to `working` (the workflow's first step). No-op if unknown. */
    markWorking(taskId: string): void {
      const task = readOne(taskId);
      if (!task) return;
      task.status = { ...task.status, state: "working", timestamp: nowIso() };
      upsert(task);
    },

    /** Persist the terminal completed Task (the workflow's `complete` step). */
    complete(task: Task): void {
      upsert(task);
    },

    /**
     * Best-effort cancel: flip the task to `canceled` and return it. The
     * in-flight workflow's `notify` step skips a canceled task.
     */
    cancel(taskId: string): PlainTask | null {
      const task = readOne(taskId);
      if (!task) return null;
      task.status = { ...task.status, state: "canceled", timestamp: nowIso() };
      upsert(task);
      return task;
    },

    /** Delete all tasks older than 30 days (called by the weekly maintenance cron). */
    cleanup(): void {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      db.delete(notifyTasks).where(lt(notifyTasks.createdAt, cutoff)).run();
    }
  };
}
