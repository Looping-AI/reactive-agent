import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { MockLanguageModelV3 } from "ai/test";
import type { Schedule } from "agents";
import { TaskState } from "@a2a-js/sdk";
import type { ReactiveAgent } from "@/reactive-agent";
import type { AgentDB } from "@/db/db";
import { subagentName } from "@/subagent";
import { sessionText } from "@/agent/history";
import { createModelPair, type ModelPair } from "@/agent/model";
import { MAIN_AGENT_LIMITS } from "@/config";
import { testAgentMessage, testTask } from "../fixtures";
import { freshStub } from "../helpers/do";

/**
 * Real-DO integration coverage for the `ReactiveAgent` DO: its own Session
 * ownership — everything `test/index.spec.ts`'s fake-DO test deliberately does NOT
 * exercise. That test unit-tests the outer Worker's own routing/identity forwarding
 * in isolation; this one integration-tests the DO's internals for real (real
 * SQLite-backed Session), driving one round via the `runTaskTurn(...)` native RPC
 * method and reading state directly with `runInDurableObject`. It doesn't care how
 * a caller got here, so no gateway JWT is involved.
 *
 * Both tests below script the model to fail (rather than reaching the real,
 * absent `env.AI` binding): the round still exhausts both models and returns a
 * typed `failed`, the same graceful path production takes when both models
 * produce nothing usable, but without the noisy "Binding AI needs to be run
 * remotely" exception workerd logs for every real attempt.
 */

/** A pair whose only model always throws — both primary and fallback exhaust. */
function throwingPair(message: string): ModelPair {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error(message);
    }
  });
  return createModelPair({ model });
}

/** The verified caller a real Worker would pass to `runTaskTurn`. */
const IDENTITY = { key: "test:1:ada", name: "Ada", kind: "custom" };

describe("ReactiveAgent — Session persistence (real SQLite)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists the raw user turn before the (unavailable) model is called", async () => {
    const stub = freshStub("session");
    // Round 0 appends the inbound turn first, then infers — so the turn is
    // durable even though the model never answers and no reply is appended.
    await runInDurableObject(stub, async (instance) => {
      instance.modelsOverride = throwingPair("model unavailable");
      await instance.runTaskTurn({
        taskId: "t-session",
        text: "remember: my favorite color is teal",
        identity: IDENTITY,
        round: 0,
        mode: "open",
        turnsRemaining: MAIN_AGENT_LIMITS.maxTurns
      });
    });

    const history = await runInDurableObject(stub, (instance) =>
      instance.getSession(IDENTITY).getHistory()
    );
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(sessionText(history[0])).toBe("remember: my favorite color is teal");
  });

  it("accepts a push context without posting when the round never succeeds", async () => {
    // The model fails before any reply exists, so nothing may be posted — the
    // push context must be harmless. (The streaming path itself is
    // unit-covered by inference.spec's `onContent` and notify.spec's
    // build/sign/post helpers.)
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const stub = freshStub("push-ctx");
    const result = await runInDurableObject(stub, (instance) => {
      instance.modelsOverride = throwingPair("model unavailable");
      return instance.runTaskTurn({
        taskId: "t-push",
        text: "hello",
        identity: IDENTITY,
        round: 0,
        mode: "open",
        turnsRemaining: MAIN_AGENT_LIMITS.maxTurns,
        push: {
          taskId: "t-push",
          contextId: "c-push",
          pushUrl: "https://gateway.test/a2a/notifications",
          pushToken: "tok",
          jku: "https://agent.test/.well-known/jwks.json"
        }
      });
    });

    expect(result.status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ReactiveAgent — async task state (real SQLite)", () => {
  it("beginTask returns a submitted Task and is idempotent on messageId", async () => {
    const stub = freshStub("tasks-begin");
    const first = await runInDurableObject(stub, (instance) =>
      instance.beginTask({
        messageId: "m-1",
        taskId: "t-1",
        contextId: "c-1"
      })
    );
    expect(first.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(first.id).toBe("t-1");

    // A dispatch retry re-sends the same messageId with a fresh SDK taskId — the
    // original Task (and taskId) must come back, not a second row.
    const retry = await runInDurableObject(stub, (instance) =>
      instance.beginTask({
        messageId: "m-1",
        taskId: "t-2-different",
        contextId: "c-1"
      })
    );
    expect(retry.id).toBe("t-1");
  });

  it("saveTask persists the terminal Task readable via getTask", async () => {
    const stub = freshStub("tasks-complete");
    await runInDurableObject(stub, (instance) =>
      instance.beginTask({ messageId: "m-2", taskId: "t-9", contextId: "c-2" })
    );
    await runInDurableObject(stub, (instance) =>
      instance.saveTask(
        testTask(
          "t-9",
          "c-2",
          TaskState.TASK_STATE_COMPLETED,
          testAgentMessage("reply-1", "done", "c-2")
        )
      )
    );

    const loaded = await runInDurableObject(stub, (instance) =>
      instance.getTask("t-9")
    );
    expect(loaded?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(loaded?.status.message?.parts?.[0]?.content).toEqual({
      $case: "text",
      value: "done"
    });
  });

  it("cancelTask flips a pending task to canceled", async () => {
    const stub = freshStub("tasks-cancel");
    await runInDurableObject(stub, (instance) =>
      instance.beginTask({ messageId: "m-3", taskId: "t-3", contextId: "c-3" })
    );
    const canceled = await runInDurableObject(stub, (instance) =>
      instance.cancelTask("t-3")
    );
    expect(canceled?.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    const loaded = await runInDurableObject(stub, (instance) =>
      instance.getTask("t-3")
    );
    expect(loaded?.status.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  // Both cancel entry points converge on `markCanceled`, which is what makes the
  // in-flight abort reachable at all. `saveTask` matters most: a per-request
  // a2a-js handler has no event bus on a `tasks/cancel`, so it records the
  // cancellation through the TaskStore rather than through the executor.
  it.each([
    [
      "cancelTask",
      (i: ReactiveAgent, id: string) => i.cancelTask(id) as Promise<unknown>
    ],
    [
      "saveTask with a canceled state",
      (i: ReactiveAgent, id: string) =>
        i.saveTask(
          testTask(id, "c-ab", TaskState.TASK_STATE_CANCELED)
        ) as Promise<unknown>
    ]
  ])("%s aborts running subagents and only those", async (_name, cancel) => {
    const stub = freshStub(`cancel-abort-${_name.replace(/\W+/g, "-")}`);
    await runInDurableObject(stub, async (instance) => {
      await instance.beginTask({
        messageId: "m-ab",
        taskId: "t-ab",
        contextId: "c-ab"
      });
      const { db } = instance as unknown as { db: AgentDB };
      const rows = db.subtasks.createDecomposition("t-ab", 0, [
        {
          localKey: "a",
          type: "general",
          prompt: "p",
          references: [],
          dependsOn: [],
          params: {}
        },
        {
          localKey: "b",
          type: "general",
          prompt: "p",
          references: [],
          dependsOn: [],
          params: {}
        }
      ]);
      // Only the first is running; the second stays pending.
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });

      const abortRun = vi.fn().mockResolvedValue(true);
      const subAgent = vi
        .spyOn(instance, "subAgent")
        .mockResolvedValue({ abortRun } as never);

      await cancel(instance, "t-ab");

      expect(abortRun).toHaveBeenCalledTimes(1);
      // `subAgent` creates a facet that does not exist, so a pending row must
      // never be reached — that would materialize a child just to abort it.
      expect(subAgent).toHaveBeenCalledTimes(1);
      expect(subAgent.mock.calls[0][1]).toBe(subagentName("t-ab", rows[0].id));
      await expect(instance.getTask("t-ab")).resolves.toMatchObject({
        status: { state: TaskState.TASK_STATE_CANCELED }
      });
    });
  });

  it("getTask returns null for an unknown task", async () => {
    const stub = freshStub("tasks-missing");
    const loaded = await runInDurableObject(stub, (instance) =>
      instance.getTask("nope")
    );
    expect(loaded).toBeNull();
  });

  it("cleanupOldTasks deletes rows older than 30 days and keeps recent ones", async () => {
    const stub = freshStub("tasks-cleanup");
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;

    // Create both tasks via the public API (triggers DB init + migrations)
    await runInDurableObject(stub, (instance) =>
      instance.beginTask({
        messageId: "m-old",
        taskId: "t-old",
        contextId: "c-cleanup"
      })
    );
    await runInDurableObject(stub, (instance) =>
      instance.beginTask({
        messageId: "m-new",
        taskId: "t-new",
        contextId: "c-cleanup"
      })
    );

    // Backdate the old task directly via SQL
    await runInDurableObject(stub, (instance) => {
      void instance.sql`
        UPDATE notify_tasks SET created_at = ${thirtyOneDaysAgo} WHERE task_id = 't-old'
      `;
    });

    await runInDurableObject(stub, (instance) =>
      instance.cleanupOldTasks({}, {} as unknown as Schedule)
    );

    const oldTask = await runInDurableObject(stub, (instance) =>
      instance.getTask("t-old")
    );
    const newTask = await runInDurableObject(stub, (instance) =>
      instance.getTask("t-new")
    );

    expect(oldTask).toBeNull();
    expect(newTask).not.toBeNull();
  });
});
