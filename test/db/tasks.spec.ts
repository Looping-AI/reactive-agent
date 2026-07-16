/**
 * Unit tests for the `notify_tasks` data layer (src/db/models/tasks.ts).
 *
 * Each test constructs a real AgentDB against a fresh DO storage so every
 * query runs through the actual Drizzle + SQLite stack with real migrations —
 * no mocks, no stubs.
 */
import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { AgentDB } from "@/db/db";
import { freshStub, doStorage, withTasks } from "../helpers/do";

// ---------------------------------------------------------------------------
// begin
// ---------------------------------------------------------------------------

describe("tasks.begin", () => {
  it("creates a submitted Task on first call", async () => {
    const task = await withTasks("begin-create", (tasks) =>
      tasks.begin({ messageId: "msg-1", taskId: "t-1", contextId: "ctx-1" })
    );

    expect(task.kind).toBe("task");
    expect(task.id).toBe("t-1");
    expect(task.contextId).toBe("ctx-1");
    expect(task.status.state).toBe("submitted");
  });

  it("is idempotent on messageId — a dispatch retry returns the original task", async () => {
    const [first, retry] = await withTasks("begin-dedup", (tasks) => {
      const first = tasks.begin({
        messageId: "msg-dedup",
        taskId: "t-original",
        contextId: "ctx-1"
      });
      const retry = tasks.begin({
        messageId: "msg-dedup",
        taskId: "t-different",
        contextId: "ctx-1"
      });
      return [first, retry] as const;
    });

    expect(first.id).toBe("t-original");
    expect(retry.id).toBe("t-original");
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("tasks.get", () => {
  it("returns null for an unknown task", async () => {
    const result = await withTasks("get-missing", (tasks) =>
      tasks.get("nonexistent")
    );

    expect(result).toBeNull();
  });

  it("returns the persisted task after begin", async () => {
    const task = await withTasks("get-found", (tasks) => {
      tasks.begin({ messageId: "msg-2", taskId: "t-2", contextId: "ctx-2" });
      return tasks.get("t-2");
    });

    expect(task?.id).toBe("t-2");
    expect(task?.status.state).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

describe("tasks.save", () => {
  it("upserts a task — read-back reflects the saved state", async () => {
    const result = await withTasks("save", (tasks) => {
      const task = tasks.begin({
        messageId: "msg-3",
        taskId: "t-3",
        contextId: "ctx-3"
      });
      tasks.save({
        ...task,
        status: { ...task.status, state: "working" }
      });
      return tasks.get("t-3");
    });

    expect(result?.status.state).toBe("working");
  });
});

// ---------------------------------------------------------------------------
// markWorking
// ---------------------------------------------------------------------------

describe("tasks.markWorking", () => {
  it("transitions a submitted task to working", async () => {
    const result = await withTasks("mark-working", (tasks) => {
      tasks.begin({ messageId: "msg-4", taskId: "t-4", contextId: "ctx-4" });
      tasks.markWorking("t-4");
      return tasks.get("t-4");
    });

    expect(result?.status.state).toBe("working");
  });

  it("is a no-op for an unknown task", async () => {
    await expect(
      withTasks("mark-working-noop", (tasks) => {
        tasks.markWorking("nonexistent");
      })
    ).resolves.not.toThrow();
  });

  // `tasks/cancel` can land between the executor's `begin` and the workflow's
  // first step. An unguarded write would resurrect the task and the pipeline
  // would deliver a terminal callback for work the caller already canceled.
  it("refuses to resurrect a canceled task", async () => {
    const result = await withTasks("mark-working-canceled", (tasks) => {
      tasks.begin({ messageId: "msg-4b", taskId: "t-4b", contextId: "ctx-4b" });
      tasks.cancel("t-4b");
      tasks.markWorking("t-4b");
      return tasks.get("t-4b");
    });

    expect(result?.status.state).toBe("canceled");
  });
});

// ---------------------------------------------------------------------------
// save (terminal persistence)
// ---------------------------------------------------------------------------

describe("tasks.save", () => {
  it("persists the terminal completed Task with its reply message", async () => {
    const result = await withTasks("complete", (tasks) => {
      const task = tasks.begin({
        messageId: "msg-5",
        taskId: "t-5",
        contextId: "ctx-5"
      });
      tasks.save({
        ...task,
        status: {
          state: "completed",
          timestamp: new Date().toISOString(),
          message: {
            kind: "message",
            role: "agent",
            messageId: "reply-5",
            parts: [{ kind: "text", text: "all done" }],
            contextId: "ctx-5"
          }
        }
      });
      return tasks.get("t-5");
    });

    expect(result?.status.state).toBe("completed");
    expect(result?.status.message?.parts?.[0]).toMatchObject({
      text: "all done"
    });
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("tasks.cancel", () => {
  it("flips state to canceled and returns the updated task", async () => {
    const result = await withTasks("cancel", (tasks) => {
      tasks.begin({ messageId: "msg-6", taskId: "t-6", contextId: "ctx-6" });
      return tasks.cancel("t-6");
    });

    expect(result?.status.state).toBe("canceled");
  });

  it("returns null for an unknown task", async () => {
    const result = await withTasks("cancel-missing", (tasks) =>
      tasks.cancel("nonexistent")
    );

    expect(result).toBeNull();
  });

  it("is visible via get after cancel", async () => {
    const result = await withTasks("cancel-read-back", (tasks) => {
      tasks.begin({ messageId: "msg-7", taskId: "t-7", contextId: "ctx-7" });
      tasks.cancel("t-7");
      return tasks.get("t-7");
    });

    expect(result?.status.state).toBe("canceled");
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("tasks.cleanup", () => {
  it("deletes rows older than 30 days and keeps recent ones", async () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;

    // Uses `instance.sql` for backdating, so we drop into runInDurableObject
    // directly rather than withTasks (which doesn't expose raw instance access).
    const result = await runInDurableObject(
      freshStub("cleanup-retention"),
      (instance) => {
        const { tasks } = new AgentDB(doStorage(instance));
        tasks.begin({
          messageId: "msg-old",
          taskId: "t-old",
          contextId: "ctx-c"
        });
        tasks.begin({
          messageId: "msg-new",
          taskId: "t-new",
          contextId: "ctx-c"
        });
        void instance.sql`
          UPDATE notify_tasks SET created_at = ${thirtyOneDaysAgo} WHERE task_id = 't-old'
        `;
        tasks.cleanup();
        return { old: tasks.get("t-old"), recent: tasks.get("t-new") };
      }
    );

    expect(result.old).toBeNull();
    expect(result.recent).not.toBeNull();
  });

  it("is a no-op when all rows are within 30 days", async () => {
    const result = await withTasks("cleanup-noop", (tasks) => {
      tasks.begin({ messageId: "msg-8", taskId: "t-8", contextId: "ctx-8" });
      tasks.cleanup();
      return tasks.get("t-8");
    });

    expect(result).not.toBeNull();
  });
});
