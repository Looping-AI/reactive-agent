import { Task, TaskState, taskStateToJSON } from "@a2a-js/sdk";
import type { PlainTask } from "@/a2a/task";
import { eq, lt } from "drizzle-orm";
import { buildSubmittedTask } from "@/a2a/notify";
import { notifyTasks } from "@/db/schema";
import type { DB } from "@/db/db";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A Task's state, tolerating the `status`-less Task the SDK's generated type
 * permits (`TaskStatus | undefined`). Nothing we build omits it, so an
 * unspecified state means the row came from somewhere unexpected — and it
 * compares equal to none of the states the callers switch on.
 */
export function stateOf(task: Task): TaskState {
  return task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
}

/**
 * Query methods for the `notify_tasks` table (async A2A task state).
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as `db.tasks.*`.
 * Migrations are owned by `AgentDB`, not this factory — it only issues queries.
 *
 * Rows hold the Task in its **A2A wire form** (`Task.toJSON`), not the in-memory
 * protobuf shape the SDK hands us. Those differ under v1.0 — enums are numbers
 * in memory but `SCREAMING_SNAKE` strings on the wire, and `Part.content` is a
 * `{ $case, value }` wrapper in memory but a bare named key on the wire — so a
 * plain `JSON.stringify` would persist a shape that is neither valid A2A JSON
 * nor stable across SDK versions. Encoding on write and decoding on read keeps
 * the stored bytes the spec's own format.
 */
export function makeTasks(db: DB) {
  // Every row was written by the builders in `@/a2a/notify`, which produce
  // exactly the narrowed {@link PlainTask} shape, so the decode lands back on it.
  const parse = (row: { taskJson: string }): PlainTask =>
    Task.fromJSON(JSON.parse(row.taskJson)) as PlainTask;

  const serialize = (task: Task): string => JSON.stringify(Task.toJSON(task));

  const readOne = (taskId: string): PlainTask | null => {
    const row = db
      .select()
      .from(notifyTasks)
      .where(eq(notifyTasks.taskId, taskId))
      .get();
    return row ? parse(row) : null;
  };

  const upsert = (task: Task): void => {
    // Denormalized for observability only — nothing filters on it — so it holds
    // the readable canonical name rather than the enum's ordinal.
    const state = taskStateToJSON(stateOf(task));
    db.insert(notifyTasks)
      .values({
        taskId: task.id,
        messageId: null,
        state,
        taskJson: serialize(task),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .onConflictDoUpdate({
        target: notifyTasks.taskId,
        set: {
          state,
          taskJson: serialize(task),
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
          state: taskStateToJSON(stateOf(task)),
          taskJson: serialize(task),
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
        .run();
      return task;
    },

    /** Load a task by id (for `GetTask` via the Worker's `DurableTaskStore`). */
    get(taskId: string): PlainTask | null {
      return readOne(taskId);
    },

    /**
     * Upsert a task by id, preserving the `message_id` set by {@link begin}.
     * Returns whether the write applied.
     *
     * Guarded exactly like {@link markWorking}, and for the same reason: a
     * `canceled` row is terminal, so nothing may write a non-canceled state over
     * it. That closes the window between the workflow's terminal build and its
     * callback — the read-check-write is synchronous here, so a `CancelTask`
     * landing mid-delivery makes this return `false` and the notify never fires.
     * Writing `canceled` onto a live row stays allowed: that is how the a2a-js
     * handler's own cancel branch records the cancellation.
     */
    save(task: Task): boolean {
      const existing = readOne(task.id);
      if (
        existing !== null &&
        stateOf(existing) === TaskState.TASK_STATE_CANCELED &&
        stateOf(task) !== TaskState.TASK_STATE_CANCELED
      ) {
        return false;
      }
      upsert(task);
      return true;
    },

    /**
     * Move a task to `working` (the workflow's first step). No-op if unknown or
     * not in `submitted` state. Rejects transitions from any terminal state
     * (`canceled`, `completed`, `failed`) or from `working` itself.
     */
    markWorking(taskId: string): void {
      const task = readOne(taskId);
      if (!task || stateOf(task) !== TaskState.TASK_STATE_SUBMITTED) return;
      task.status = {
        ...task.status,
        state: TaskState.TASK_STATE_WORKING,
        message: task.status?.message,
        timestamp: nowIso()
      };
      upsert(task);
    },

    /**
     * Flip the task to `canceled` and return it. Terminal: once this lands,
     * {@link save} refuses every non-canceled write, so no completed or failed
     * callback can be built from this row afterwards.
     */
    cancel(taskId: string): PlainTask | null {
      const task = readOne(taskId);
      if (!task) return null;
      task.status = {
        ...task.status,
        state: TaskState.TASK_STATE_CANCELED,
        message: task.status?.message,
        timestamp: nowIso()
      };
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
