import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { LanguageModel } from "ai";
import type { ReactiveAgent } from "@/reactive-agent";
import { RecipeSubagent, subagentName, FINGERPRINT_MISMATCH } from "@/subagent";
import { createModelPair, type ModelPair } from "@/agent/model";
import {
  decomposeReplyMessageId,
  finalReplyMessageId,
  sessionText
} from "@/agent/history";
import { DEFAULT_RECIPE } from "@/agent/subtasks/recipe";
import type { AgentDB } from "@/db/db";
import type {
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskDraft
} from "@/agent/subtasks/types";
import type { GatewayIdentity } from "@/a2a/verify";
import { freshStub } from "../helpers/do";
import { mockModel } from "../agent/mock-model";

const IDENTITY: GatewayIdentity = {
  key: "custom:1:tests",
  name: "Ada"
} as GatewayIdentity;

const TASK_ID = "task-1";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A valid decomposition as the model emits it. */
function proposalJson(subtasks?: unknown[]): string {
  return JSON.stringify({
    reply: "On it.",
    subtasks: subtasks ?? [
      {
        localKey: "research",
        type: "research",
        prompt: "Research the thing",
        referenceIndexes: [1],
        dependsOn: []
      }
    ]
  });
}

function draft(over: Partial<SubtaskDraft> = {}): SubtaskDraft {
  return {
    localKey: "a",
    type: "research",
    prompt: "do the thing",
    references: [],
    dependsOn: [],
    ...over
  };
}

/**
 * A ModelPair that counts **inference calls**, not model construction.
 *
 * The pair must stay constructible: `getSession` builds the Session's compaction
 * summarizer from `primary()`, so a factory that throws would break session setup
 * rather than prove anything about a phase. Counting `doGenerate` measures the
 * thing the bypass and recovery paths actually promise — that no model ran.
 */
function countingPair(): ModelPair & { generations(): number } {
  let generations = 0;
  const model = mockModel({ text: "unexpected inference" });
  const orig = model.doGenerate.bind(model);
  model.doGenerate = async (options: Parameters<typeof orig>[0]) => {
    generations++;
    return orig(options);
  };
  return { ...createModelPair({ model }), generations: () => generations };
}

function pairOf(model: LanguageModel): ModelPair {
  return createModelPair({ model });
}

/**
 * Stub the managed-child lifecycle on a real DO instance. `subAgent` resolves to a
 * fake child whose `execute` is scripted, so the parent's ordering rules (claim,
 * reset, persist, delete) can be asserted without a real facet or a real model.
 */
function stubChild(
  instance: ReactiveAgent,
  execute: (request: RecipeExecutionRequest) => Promise<RecipeExecutionResult>
) {
  const executeSpy = vi.fn(execute);
  const subAgent = vi
    .spyOn(instance, "subAgent")
    .mockResolvedValue({ execute: executeSpy } as never);
  const deleteSubAgent = vi
    .spyOn(instance, "deleteSubAgent")
    .mockResolvedValue(undefined);
  return { executeSpy, subAgent, deleteSubAgent };
}

const OK: RecipeExecutionResult = {
  status: "completed",
  resultParts: [{ kind: "text", text: "the finding" }],
  modelId: "primary-model"
};

/**
 * Seed a decomposition and reach the DO's own data layer.
 *
 * `db` is private on the agent; the tests drive real rows through the same handle
 * the RPCs use, so a seeded DAG is indistinguishable from a decomposed one.
 */
function seed(instance: ReactiveAgent, drafts: SubtaskDraft[]) {
  const { db } = instance as unknown as { db: AgentDB };
  return { rows: db.subtasks.createDecomposition(TASK_ID, drafts), db };
}

describe("decomposeTask", () => {
  it("persists the DAG and returns the first reply", async () => {
    await runInDurableObject(freshStub("decompose"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel({ text: proposalJson() }));

      const result = await instance.decomposeTask({
        taskId: TASK_ID,
        text: "book me a flight",
        identity: IDENTITY
      });

      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(result.reply).toBe("On it.");
      expect(result.subtasks).toHaveLength(1);
      expect(result.subtasks[0].type).toBe("research");
      expect(result.subtasks[0].status).toBe("pending");
      // The model selected index 1 — the inbound turn, snapshotted verbatim.
      expect(result.subtasks[0].references).toEqual([
        { role: "user", text: "book me a flight" }
      ]);
    });
  });

  it("makes the reply durable in the session", async () => {
    await runInDurableObject(
      freshStub("decompose-session"),
      async (instance) => {
        instance.modelsOverride = pairOf(mockModel({ text: proposalJson() }));
        await instance.decomposeTask({
          taskId: TASK_ID,
          text: "hello",
          identity: IDENTITY
        });

        const stored = await instance
          .getSession(IDENTITY)
          .getMessage(decomposeReplyMessageId(TASK_ID));
        expect(stored && sessionText(stored)).toBe("On it.");
      }
    );
  });

  it("recovers on a re-run without re-inferring or duplicating rows", async () => {
    await runInDurableObject(
      freshStub("decompose-replay"),
      async (instance) => {
        instance.modelsOverride = pairOf(mockModel({ text: proposalJson() }));
        await instance.decomposeTask({
          taskId: TASK_ID,
          text: "hello",
          identity: IDENTITY
        });

        const models = countingPair();
        instance.modelsOverride = models;
        const again = await instance.decomposeTask({
          taskId: TASK_ID,
          text: "hello",
          identity: IDENTITY
        });

        expect(again.status).toBe("completed");
        if (again.status !== "completed") return;
        expect(again.reply).toBe("On it.");
        expect(again.subtasks).toHaveLength(1);
        expect(models.generations()).toBe(0);
        expect(await instance.listSubtasks(TASK_ID)).toHaveLength(1);
      }
    );
  });

  it("returns a typed failure when the model output is unusable", async () => {
    await runInDurableObject(freshStub("decompose-fail"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel({ text: "not json" }));
      const result = await instance.decomposeTask({
        taskId: TASK_ID,
        text: "hello",
        identity: IDENTITY
      });
      expect(result.status).toBe("failed");
      // Nothing persisted: no subtask is ever synthesized.
      expect(await instance.listSubtasks(TASK_ID)).toEqual([]);
    });
  });

  it("persists a multi-node DAG with resolved dependency edges", async () => {
    await runInDurableObject(freshStub("decompose-dag"), async (instance) => {
      instance.modelsOverride = pairOf(
        mockModel({
          text: proposalJson([
            {
              localKey: "research",
              type: "research",
              prompt: "research",
              referenceIndexes: [1],
              dependsOn: []
            },
            {
              localKey: "draft",
              type: "draft",
              prompt: "draft it",
              referenceIndexes: [],
              dependsOn: ["research"]
            }
          ])
        })
      );
      const result = await instance.decomposeTask({
        taskId: TASK_ID,
        text: "hello",
        identity: IDENTITY
      });
      if (result.status !== "completed") throw new Error("expected completed");
      const [research, drafted] = result.subtasks;
      expect(drafted.dependsOn).toEqual([research.id]);
    });
  });
});

describe("executeSubtask — happy path and lifecycle ordering", () => {
  it("runs the child and records the result", async () => {
    await runInDurableObject(freshStub("exec"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      const { executeSpy } = stubChild(instance, async () => OK);

      const done = await instance.executeSubtask(rows[0].id);

      expect(done.status).toBe("completed");
      expect(done.resultParts).toEqual([{ kind: "text", text: "the finding" }]);
      expect(executeSpy).toHaveBeenCalledOnce();
    });
  });

  it("records the resolved recipe id and version at execution start", async () => {
    await runInDurableObject(freshStub("exec-recipe"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      stubChild(instance, async () => OK);

      const done = await instance.executeSubtask(rows[0].id);
      expect(done.recipeId).toBe(DEFAULT_RECIPE.key);
      expect(done.recipeVersion).toBe(DEFAULT_RECIPE.version);
    });
  });

  it("sends the subtask's prompt and verbatim references to the child", async () => {
    await runInDurableObject(freshStub("exec-request"), async (instance) => {
      const references = [{ role: "user" as const, text: "the exact turn" }];
      const { rows } = seed(instance, [draft({ references })]);
      const { executeSpy } = stubChild(instance, async () => OK);

      await instance.executeSubtask(rows[0].id);

      const request = executeSpy.mock.calls[0][0];
      expect(request.prompt).toBe("do the thing");
      expect(request.references).toEqual(references);
      expect(request.recipe.key).toBe(DEFAULT_RECIPE.key);
      expect(request.dependencyResults).toEqual([]);
    });
  });

  it("deletes the child only after the result is durable", async () => {
    await runInDurableObject(freshStub("exec-order"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      const { executeSpy, deleteSubAgent } = stubChild(
        instance,
        async () => OK
      );
      const complete = vi.spyOn(db.subtasks, "complete");

      await instance.executeSubtask(rows[0].id);

      // Fresh execution resets stale state first, then persists, then deletes.
      expect(deleteSubAgent.mock.invocationCallOrder[0]).toBeLessThan(
        executeSpy.mock.invocationCallOrder[0]
      );
      expect(complete.mock.invocationCallOrder[0]).toBeLessThan(
        deleteSubAgent.mock.invocationCallOrder[1]
      );
    });
  });

  it("passes completed dependency results in ordinal order", async () => {
    await runInDurableObject(freshStub("exec-deps"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a", type: "research" }),
        draft({ localKey: "b", type: "research" }),
        draft({ localKey: "c", dependsOn: ["a", "b"] })
      ]);
      for (const i of [0, 1]) {
        db.subtasks.start(rows[i].id, {
          recipeId: "default",
          recipeVersion: 1
        });
        db.subtasks.complete(rows[i].id, [
          { kind: "text", text: `result ${i}` }
        ]);
      }
      const { executeSpy } = stubChild(instance, async () => OK);

      await instance.executeSubtask(rows[2].id);

      const request = executeSpy.mock.calls[0][0];
      expect(request.dependencyResults.map((d) => d.subtaskId)).toEqual([
        rows[0].id,
        rows[1].id
      ]);
      expect(request.dependencyResults[0].resultParts).toEqual([
        { kind: "text", text: "result 0" }
      ]);
    });
  });

  it("records a failed child result as a branch failure", async () => {
    await runInDurableObject(freshStub("exec-failed"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      stubChild(instance, async () => ({
        status: "failed",
        error: "recipe exhausted",
        modelId: null
      }));

      const done = await instance.executeSubtask(rows[0].id);
      expect(done.status).toBe("failed");
      expect(done.error).toBe("recipe exhausted");
    });
  });

  it("records a contract-breaking completed result as a failure, not a retry loop", async () => {
    await runInDurableObject(freshStub("exec-malformed"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      stubChild(instance, async () => ({
        status: "completed",
        resultParts: [{ kind: "text", text: "   " }],
        modelId: "primary-model"
      }));

      const done = await instance.executeSubtask(rows[0].id);
      expect(done.status).toBe("failed");
      expect(done.error).toContain("malformed result");
    });
  });
});

describe("executeSubtask — retry and recovery", () => {
  it("short-circuits a terminal subtask without invoking the child", async () => {
    await runInDurableObject(freshStub("exec-terminal"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.complete(rows[0].id, [
        { kind: "text", text: "done already" }
      ]);

      const { executeSpy, deleteSubAgent } = stubChild(
        instance,
        async () => OK
      );
      const done = await instance.executeSubtask(rows[0].id);

      expect(done.status).toBe("completed");
      expect(executeSpy).not.toHaveBeenCalled();
      // Sweeps a possible leaked child from a crash after persist.
      expect(deleteSubAgent).toHaveBeenCalledOnce();
    });
  });

  it("does not delete the child when retrying an already-running subtask", async () => {
    await runInDurableObject(freshStub("exec-ambiguous"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      // A previous attempt claimed the row and crashed mid-execution.
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });

      const { executeSpy, deleteSubAgent } = stubChild(
        instance,
        async () => OK
      );
      await instance.executeSubtask(rows[0].id);

      // The child may hold the cached terminal result — deleting it pre-execution
      // would throw that away and force a re-inference.
      expect(deleteSubAgent.mock.invocationCallOrder[0]).toBeGreaterThan(
        executeSpy.mock.invocationCallOrder[0]
      );
    });
  });

  it("recreates the child once on a fingerprint mismatch", async () => {
    await runInDurableObject(freshStub("exec-mismatch"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      let call = 0;
      const { subAgent, deleteSubAgent } = stubChild(instance, async () => {
        if (++call === 1) throw new Error(`${FINGERPRINT_MISMATCH}: stale`);
        return OK;
      });

      const done = await instance.executeSubtask(rows[0].id);

      expect(done.status).toBe("completed");
      expect(call).toBe(2);
      expect(subAgent).toHaveBeenCalledTimes(2);
      expect(deleteSubAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("propagates a second fingerprint mismatch as a lifecycle bug", async () => {
    await runInDurableObject(freshStub("exec-mismatch-2"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      stubChild(instance, async () => {
        throw new Error(`${FINGERPRINT_MISMATCH}: still stale`);
      });

      await expect(instance.executeSubtask(rows[0].id)).rejects.toThrow(
        FINGERPRINT_MISMATCH
      );
    });
  });

  it("propagates a transient fault and persists nothing", async () => {
    await runInDurableObject(freshStub("exec-transient"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      stubChild(instance, async () => {
        throw new Error("3040: capacity temporarily exceeded");
      });

      await expect(instance.executeSubtask(rows[0].id)).rejects.toThrow(/3040/);
      // Left running for the step retry to resume.
      expect((await instance.listSubtasks(TASK_ID))[0].status).toBe("running");
    });
  });

  it("throws on an unknown subtask", async () => {
    await runInDurableObject(freshStub("exec-unknown"), async (instance) => {
      await expect(instance.executeSubtask(9999)).rejects.toThrow(
        /unknown subtask/
      );
    });
  });

  it("throws when a dependency has not completed (scheduler bug)", async () => {
    await runInDurableObject(freshStub("exec-early"), async (instance) => {
      const { rows } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b", dependsOn: ["a"] })
      ]);
      stubChild(instance, async () => OK);

      await expect(instance.executeSubtask(rows[1].id)).rejects.toThrow(
        /ran before dependency/
      );
    });
  });
});

describe("executeSubtask — cancellation", () => {
  it("does not start work for a canceled task", async () => {
    await runInDurableObject(freshStub("exec-cancel-pre"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      await instance.beginTask({
        messageId: "m1",
        taskId: TASK_ID,
        contextId: "c1"
      });
      await instance.cancelTask(TASK_ID);
      const { executeSpy } = stubChild(instance, async () => OK);

      const row = await instance.executeSubtask(rows[0].id);
      expect(executeSpy).not.toHaveBeenCalled();
      expect(row.status).toBe("pending");
    });
  });

  it("resolves a row left running by a crashed attempt when the task is canceled", async () => {
    await runInDurableObject(
      freshStub("exec-cancel-stuck"),
      async (instance) => {
        const { rows, db } = seed(instance, [draft()]);
        await instance.beginTask({
          messageId: "m1",
          taskId: TASK_ID,
          contextId: "c1"
        });
        // A previous attempt claimed the row and crashed; then the task was canceled.
        db.subtasks.start(rows[0].id, {
          recipeId: "default",
          recipeVersion: 1
        });
        await instance.cancelTask(TASK_ID);
        const { executeSpy } = stubChild(instance, async () => OK);

        const row = await instance.executeSubtask(rows[0].id);

        // cancelPending only reaches pending rows, so this path must resolve it —
        // otherwise the row stays `running` until the 30-day cleanup.
        expect(row.status).toBe("canceled");
        expect(executeSpy).not.toHaveBeenCalled();
      }
    );
  });

  it("discards a late result and leaves a truthful terminal state", async () => {
    await runInDurableObject(
      freshStub("exec-cancel-late"),
      async (instance) => {
        const { rows } = seed(instance, [draft()]);
        await instance.beginTask({
          messageId: "m1",
          taskId: TASK_ID,
          contextId: "c1"
        });
        // Cancel while the child is running.
        const { deleteSubAgent } = stubChild(instance, async () => {
          await instance.cancelTask(TASK_ID);
          return OK;
        });

        const row = await instance.executeSubtask(rows[0].id);

        expect(row.status).toBe("canceled");
        expect(row.resultParts).toBeNull();
        expect(deleteSubAgent).toHaveBeenCalled();
      }
    );
  });
});

describe("skipBlockedSubtasks", () => {
  it("skips a pending node whose dependency failed", async () => {
    await runInDurableObject(freshStub("skip"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b", dependsOn: ["a"] })
      ]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.fail(rows[0].id, "boom");

      const after = await instance.skipBlockedSubtasks(TASK_ID);
      expect(after.map((s) => s.status)).toEqual(["failed", "skipped"]);
    });
  });

  it("propagates skipping down a chain to a fixpoint", async () => {
    await runInDurableObject(freshStub("skip-chain"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b", dependsOn: ["a"] }),
        draft({ localKey: "c", dependsOn: ["b"] })
      ]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.fail(rows[0].id, "boom");

      const after = await instance.skipBlockedSubtasks(TASK_ID);
      // c is skipped transitively, via b.
      expect(after.map((s) => s.status)).toEqual([
        "failed",
        "skipped",
        "skipped"
      ]);
    });
  });

  it("leaves independent branches alone", async () => {
    await runInDurableObject(
      freshStub("skip-independent"),
      async (instance) => {
        const { rows, db } = seed(instance, [
          draft({ localKey: "a" }),
          draft({ localKey: "b", dependsOn: ["a"] }),
          draft({ localKey: "solo" })
        ]);
        db.subtasks.start(rows[0].id, {
          recipeId: "default",
          recipeVersion: 1
        });
        db.subtasks.fail(rows[0].id, "boom");

        const after = await instance.skipBlockedSubtasks(TASK_ID);
        expect(after[2].status).toBe("pending");
      }
    );
  });

  it("skips a fan-in node when any one prerequisite failed", async () => {
    await runInDurableObject(freshStub("skip-diamond"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "root" }),
        draft({ localKey: "left", dependsOn: ["root"] }),
        draft({ localKey: "right", dependsOn: ["root"] }),
        draft({ localKey: "join", dependsOn: ["left", "right"] })
      ]);
      for (const i of [0, 1]) {
        db.subtasks.start(rows[i].id, {
          recipeId: "default",
          recipeVersion: 1
        });
      }
      db.subtasks.complete(rows[0].id, [{ kind: "text", text: "ok" }]);
      db.subtasks.fail(rows[1].id, "boom");

      const after = await instance.skipBlockedSubtasks(TASK_ID);
      expect(after[2].status).toBe("pending"); // right — root succeeded
      expect(after[3].status).toBe("skipped"); // join — left failed
    });
  });

  it("changes nothing when every dependency succeeded", async () => {
    await runInDurableObject(freshStub("skip-none"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b", dependsOn: ["a"] })
      ]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.complete(rows[0].id, [{ kind: "text", text: "ok" }]);

      const after = await instance.skipBlockedSubtasks(TASK_ID);
      expect(after[1].status).toBe("pending");
    });
  });
});

describe("cancelPendingSubtasks and listSubtasks", () => {
  it("cancels pending subtasks and reports the count", async () => {
    await runInDurableObject(freshStub("cancel-pending"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" })
      ]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });

      expect(await instance.cancelPendingSubtasks(TASK_ID)).toBe(1);
      const after = await instance.listSubtasks(TASK_ID);
      expect(after.map((s) => s.status)).toEqual(["running", "canceled"]);
    });
  });

  it("lists subtasks in ordinal order", async () => {
    await runInDurableObject(freshStub("list"), async (instance) => {
      seed(instance, [
        draft({ localKey: "a", type: "first" }),
        draft({ localKey: "b", type: "second" })
      ]);
      expect((await instance.listSubtasks(TASK_ID)).map((s) => s.type)).toEqual(
        ["first", "second"]
      );
    });
  });
});

describe("composeTask", () => {
  it("bypasses inference for a single successful subtask", async () => {
    await runInDurableObject(freshStub("compose-single"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.complete(rows[0].id, [{ kind: "text", text: "the answer" }]);

      const models = countingPair();
      instance.modelsOverride = models;
      const result = await instance.composeTask({
        taskId: TASK_ID,
        identity: IDENTITY
      });

      expect(result).toEqual({ status: "completed", reply: "the answer" });
      expect(models.generations()).toBe(0);
    });
  });

  it("composes multiple branches and persists the final reply", async () => {
    await runInDurableObject(freshStub("compose-multi"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" })
      ]);
      for (const i of [0, 1]) {
        db.subtasks.start(rows[i].id, {
          recipeId: "default",
          recipeVersion: 1
        });
        db.subtasks.complete(rows[i].id, [{ kind: "text", text: `part ${i}` }]);
      }

      instance.modelsOverride = pairOf(mockModel({ text: "composed answer" }));
      const result = await instance.composeTask({
        taskId: TASK_ID,
        identity: IDENTITY
      });

      expect(result).toEqual({ status: "completed", reply: "composed answer" });
      const stored = await instance
        .getSession(IDENTITY)
        .getMessage(finalReplyMessageId(TASK_ID));
      expect(stored && sessionText(stored)).toBe("composed answer");
    });
  });

  it("fails without inference when no branch succeeded", async () => {
    await runInDurableObject(freshStub("compose-none"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.fail(rows[0].id, "boom");

      const models = countingPair();
      instance.modelsOverride = models;
      const result = await instance.composeTask({
        taskId: TASK_ID,
        identity: IDENTITY
      });

      expect(result.status).toBe("failed");
      expect(models.generations()).toBe(0);
    });
  });

  it("fails for a task with no subtasks", async () => {
    await runInDurableObject(freshStub("compose-empty"), async (instance) => {
      const result = await instance.composeTask({
        taskId: "nonexistent",
        identity: IDENTITY
      });
      expect(result.status).toBe("failed");
    });
  });
});

describe("failSubtask", () => {
  // The Workflow calls this only after `execute:<id>` exhausted every retry, so
  // nobody else is left to resolve the row.
  it("fails a running subtask and sweeps its managed child", async () => {
    await runInDurableObject(freshStub("fail-running"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      const del = vi
        .spyOn(instance, "deleteSubAgent")
        .mockResolvedValue(undefined);

      await instance.failSubtask(rows[0].id, "retries exhausted");

      const row = (await instance.listSubtasks(TASK_ID))[0];
      expect(row.status).toBe("failed");
      expect(row.error).toBe("retries exhausted");
      expect(del).toHaveBeenCalledWith(
        RecipeSubagent,
        subagentName(TASK_ID, rows[0].id)
      );
    });
  });

  it("fails a subtask that threw before it was ever claimed", async () => {
    await runInDurableObject(freshStub("fail-pending"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      vi.spyOn(instance, "deleteSubAgent").mockResolvedValue(undefined);

      await instance.failSubtask(rows[0].id, "dependency invariant");

      expect((await instance.listSubtasks(TASK_ID))[0].status).toBe("failed");
    });
  });

  it("leaves a terminal result alone and never throws on an unknown id", async () => {
    await runInDurableObject(freshStub("fail-terminal"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.complete(rows[0].id, [{ kind: "text", text: "done" }]);
      vi.spyOn(instance, "deleteSubAgent").mockResolvedValue(undefined);

      await instance.failSubtask(rows[0].id, "too late");
      expect((await instance.listSubtasks(TASK_ID))[0].status).toBe(
        "completed"
      );

      await expect(instance.failSubtask(9999, "who?")).resolves.toBeUndefined();
    });
  });
});

describe("executeSubtask — real facet integration", () => {
  it("records a terminal failure and leaves no child behind", async () => {
    await runInDurableObject(freshStub("exec-real"), async (instance) => {
      const { rows } = seed(instance, [draft()]);

      // No stubbing: a real RecipeSubagent facet runs. env.AI has no local mode,
      // so the child exhausts both models and returns a terminal failure — which
      // is exactly the parent path we want proven end-to-end.
      const done = await instance.executeSubtask(rows[0].id);

      expect(done.status).toBe("failed");
      expect(done.error).toContain("recipe exhausted");
      // The child was deleted only after the result was durably copied here.
      expect(instance.listSubAgents(RecipeSubagent)).toEqual([]);
      expect(
        instance.hasSubAgent(RecipeSubagent, subagentName(TASK_ID, rows[0].id))
      ).toBe(false);
    });
  });
});
