import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { LanguageModel } from "ai";
import type { ReactiveAgent } from "@/reactive-agent";
import { RecipeSubagent, subagentName, FINGERPRINT_MISMATCH } from "@/subagent";
import { createModelPair, type ModelPair } from "@/agent/model";
import {
  finalReplyMessageId,
  roundAckMessageId,
  sessionText
} from "@/agent/history";
import { DEFAULT_RECIPE } from "@/agent/subtasks/registry";
import { DELEGATE_TOOL_NAME } from "@/agent/subtasks/delegate";
import type { AgentDB } from "@/db/db";
import type {
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  Subtask,
  SubtaskDraft
} from "@/agent/subtasks/types";
import type { GatewayIdentity } from "@/a2a/verify";
import { freshStub } from "../helpers/do";
import { mockModel, type MockStep } from "../agent/mock-model";

const IDENTITY: GatewayIdentity = {
  key: "custom:1:tests",
  name: "Ada"
} as GatewayIdentity;

const TASK_ID = "task-1";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The `delegate` call a model makes to emit a valid decomposition. */
function delegates(subtasks?: unknown[]): MockStep {
  return {
    toolCall: {
      toolName: DELEGATE_TOOL_NAME,
      input: {
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
      }
    }
  };
}

/**
 * The scan's nodes, asserting it did not report a cancellation — these specs
 * exercise skip propagation, where a canceled verdict would mean the fixture is
 * wrong rather than the assertion failing somewhere less obvious.
 */
async function scanNodes(instance: ReactiveAgent, round = 0, taskId = TASK_ID) {
  const scan = await instance.skipBlockedSubtasks(taskId, round);
  if (scan.canceled) throw new Error("unexpected cancellation in scan");
  return scan.nodes;
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
 * fake child whose scripted result the parent's single-chunk path returns, so the
 * ordering rules (claim, reset, persist, delete) can be asserted without a real
 * facet or a real model. The fake `executeChunk` wraps the scripted terminal
 * result as a done chunk — every stubbed subtask here finishes in one chunk.
 */
function stubChild(
  instance: ReactiveAgent,
  execute: (request: RecipeExecutionRequest) => Promise<RecipeExecutionResult>
) {
  const executeSpy = vi.fn(execute);
  const executeChunk = vi.fn(
    async (request: RecipeExecutionRequest): Promise<RecipeChunkResult> => ({
      done: true,
      result: await executeSpy(request),
      progress: []
    })
  );
  const abortExecution = vi.fn().mockResolvedValue(undefined);
  const subAgent = vi
    .spyOn(instance, "subAgent")
    .mockResolvedValue({ executeChunk, abortExecution } as never);
  const deleteSubAgent = vi
    .spyOn(instance, "deleteSubAgent")
    .mockResolvedValue(undefined);
  return { executeSpy, executeChunk, abortExecution, subAgent, deleteSubAgent };
}

/**
 * Run one Subtask to termination through the chunk RPC and return its terminal
 * row. Single-chunk here (the stub or the real facet-failure path finishes on
 * chunk 0), so this mirrors what the old `executeSubtask` returned directly.
 */
async function exec(instance: ReactiveAgent, id: number): Promise<Subtask> {
  await instance.executeSubtaskChunk(id, 0);
  const row = (await instance.listSubtasks(TASK_ID)).find((s) => s.id === id);
  if (!row) throw new Error(`subtask ${id} not found after execution`);
  return row;
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
function seed(instance: ReactiveAgent, drafts: SubtaskDraft[], round = 0) {
  const { db } = instance as unknown as { db: AgentDB };
  return { rows: db.subtasks.createDecomposition(TASK_ID, round, drafts), db };
}

/** Run one round with the standard inputs; only what a test cares about varies. */
function turn(
  instance: ReactiveAgent,
  over: { round?: number; text?: string; allowControl?: boolean } = {}
) {
  return instance.runTaskTurn({
    taskId: TASK_ID,
    text: over.text ?? "book me a flight",
    identity: IDENTITY,
    round: over.round ?? 0,
    allowControl: over.allowControl ?? true
  });
}

describe("runTaskTurn — delegating", () => {
  it("persists the DAG and returns the acknowledgment", async () => {
    await runInDurableObject(freshStub("turn-delegate"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel(delegates()));

      const result = await turn(instance);

      expect(result.status).toBe("delegated");
      if (result.status !== "delegated") return;
      expect(result.reply).toBe("On it.");
      expect(result.subtasks).toHaveLength(1);
      expect(result.subtasks[0].type).toBe("research");
      expect(result.subtasks[0].status).toBe("pending");
      expect(result.subtasks[0].round).toBe(0);
      // The model selected index 1 — the inbound turn, snapshotted verbatim.
      expect(result.subtasks[0].references).toEqual([
        { role: "user", text: "book me a flight" }
      ]);
    });
  });

  it("puts the Session's own memory tools on the round", async () => {
    await runInDurableObject(freshStub("turn-tools"), async (instance) => {
      // The soul instructs the model to record durable facts with `set_context`,
      // so it has to actually reach the provider — the Session owns that tool,
      // and nothing else can supply it.
      const model = mockModel(delegates());
      const orig = model.doGenerate.bind(model);
      let names: string[] = [];
      model.doGenerate = async (options: Parameters<typeof orig>[0]) => {
        names = (options.tools ?? []).map((t) => t.name);
        return orig(options);
      };
      instance.modelsOverride = pairOf(model);

      await turn(instance);

      expect(names).toContain("set_context");
      expect(names).toContain(DELEGATE_TOOL_NAME);
    });
  });

  it("makes the acknowledgment durable in the session", async () => {
    await runInDurableObject(freshStub("turn-ack"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel(delegates()));
      await turn(instance, { text: "hello" });

      const stored = await instance
        .getSession(IDENTITY)
        .getMessage(roundAckMessageId(TASK_ID, 0));
      expect(stored && sessionText(stored)).toBe("On it.");
    });
  });

  it("recovers on a re-run without re-inferring or duplicating rows", async () => {
    await runInDurableObject(freshStub("turn-replay"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel(delegates()));
      await turn(instance, { text: "hello" });

      const models = countingPair();
      instance.modelsOverride = models;
      const again = await turn(instance, { text: "hello" });

      expect(again.status).toBe("delegated");
      if (again.status !== "delegated") return;
      expect(again.reply).toBe("On it.");
      expect(again.subtasks).toHaveLength(1);
      expect(models.generations()).toBe(0);
      expect(await instance.listSubtasks(TASK_ID)).toHaveLength(1);
    });
  });

  it("returns a typed failure when the model output is unusable", async () => {
    await runInDurableObject(freshStub("turn-fail"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel({ text: "" }));
      const result = await turn(instance, { text: "hello" });
      expect(result.status).toBe("failed");
      // Nothing persisted: no subtask is ever synthesized.
      expect(await instance.listSubtasks(TASK_ID)).toEqual([]);
    });
  });

  it("persists a multi-node DAG with resolved dependency edges", async () => {
    await runInDurableObject(freshStub("turn-dag"), async (instance) => {
      instance.modelsOverride = pairOf(
        mockModel(
          delegates([
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
        )
      );
      const result = await turn(instance, { text: "hello" });
      if (result.status !== "delegated") throw new Error("expected delegated");
      const [research, drafted] = result.subtasks;
      expect(drafted.dependsOn).toEqual([research.id]);
    });
  });

  it("persists a later round's DAG alongside the first round's rows", async () => {
    await runInDurableObject(freshStub("turn-round-1"), async (instance) => {
      seed(instance, [draft()]);
      instance.modelsOverride = pairOf(
        mockModel(
          delegates([
            { localKey: "more", type: "research", prompt: "dig", dependsOn: [] }
          ])
        )
      );

      const result = await turn(instance, { round: 1 });

      if (result.status !== "delegated") throw new Error("expected delegated");
      expect(result.subtasks.map((s) => s.round)).toEqual([1]);
      // Both rounds' rows live under the same Task, in one stable order.
      const all = await instance.listSubtasks(TASK_ID);
      expect(all.map((s) => s.ordinal)).toEqual([0, 1]);
    });
  });
});

describe("runTaskTurn — answering", () => {
  it("treats plain text as the terminal reply and persists it", async () => {
    await runInDurableObject(freshStub("turn-reply"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel({ text: "the answer" }));

      const result = await turn(instance);

      expect(result).toEqual({ status: "replied", reply: "the answer" });
      // No subtask was created for a request the agent answered itself.
      expect(await instance.listSubtasks(TASK_ID)).toEqual([]);
      const stored = await instance
        .getSession(IDENTITY)
        .getMessage(finalReplyMessageId(TASK_ID));
      expect(stored && sessionText(stored)).toBe("the answer");
    });
  });

  it("returns the durable answer on a re-run, with no inference", async () => {
    await runInDurableObject(freshStub("turn-answered"), async (instance) => {
      instance.modelsOverride = pairOf(mockModel({ text: "first answer" }));
      await turn(instance);

      const models = countingPair();
      instance.modelsOverride = models;
      const again = await turn(instance, { round: 1 });

      // Re-answering could produce different words for a reply the user may
      // already have received.
      expect(again).toEqual({ status: "replied", reply: "first answer" });
      expect(models.generations()).toBe(0);
    });
  });

  it("composes a completed branch rather than shipping its text raw", async () => {
    await runInDurableObject(freshStub("turn-compose"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.complete(rows[0].id, [{ kind: "text", text: "raw finding" }]);

      instance.modelsOverride = pairOf(mockModel({ text: "composed answer" }));
      const result = await turn(instance, { round: 1 });

      expect(result).toEqual({
        status: "replied",
        reply: "composed answer"
      });
      const stored = await instance
        .getSession(IDENTITY)
        .getMessage(finalReplyMessageId(TASK_ID));
      expect(stored && sessionText(stored)).toBe("composed answer");
    });
  });

  it("gives a later round every round's branches to answer from", async () => {
    await runInDurableObject(freshStub("turn-branches"), async (instance) => {
      const { rows, db } = seed(instance, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" })
      ]);
      for (const [i, part] of ["alpha", "beta"].entries()) {
        db.subtasks.start(rows[i].id, {
          recipeId: "default",
          recipeVersion: 1
        });
        db.subtasks.complete(rows[i].id, [{ kind: "text", text: part }]);
      }

      const model = mockModel({ text: "composed answer" });
      const orig = model.doGenerate.bind(model);
      let seen = "";
      model.doGenerate = async (options: Parameters<typeof orig>[0]) => {
        seen = JSON.stringify(options.prompt);
        return orig(options);
      };
      instance.modelsOverride = pairOf(model);

      await turn(instance, { round: 1 });

      // The branch outcomes reach the model as the delegate call's result.
      expect(seen).toContain("alpha");
      expect(seen).toContain("beta");
    });
  });

  it("degrades to the durable work when the models are unusable", async () => {
    await runInDurableObject(freshStub("turn-degrade"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.complete(rows[0].id, [{ kind: "text", text: "the finding" }]);

      instance.modelsOverride = pairOf(mockModel({ text: "" }));
      const result = await turn(instance, { round: 1 });

      // The branch work is done and durable — deliver it rather than failing.
      expect(result).toEqual({ status: "replied", reply: "the finding" });
    });
  });

  it("fails when the models are unusable and nothing succeeded", async () => {
    await runInDurableObject(freshStub("turn-nothing"), async (instance) => {
      const { rows, db } = seed(instance, [draft()]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.fail(rows[0].id, "boom");

      instance.modelsOverride = pairOf(mockModel({ text: "" }));
      const result = await turn(instance, { round: 1 });

      expect(result.status).toBe("failed");
    });
  });
});

describe("executeSubtaskChunk — happy path and lifecycle ordering", () => {
  it("runs the child and records the result", async () => {
    await runInDurableObject(freshStub("exec"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      const { executeSpy } = stubChild(instance, async () => OK);

      const done = await exec(instance, rows[0].id);

      expect(done.status).toBe("completed");
      expect(done.resultParts).toEqual([{ kind: "text", text: "the finding" }]);
      expect(executeSpy).toHaveBeenCalledOnce();
    });
  });

  it("records the resolved recipe id and version at execution start", async () => {
    await runInDurableObject(freshStub("exec-recipe"), async (instance) => {
      const { rows } = seed(instance, [draft()]);
      stubChild(instance, async () => OK);

      const done = await exec(instance, rows[0].id);
      expect(done.recipeId).toBe(DEFAULT_RECIPE.key);
      expect(done.recipeVersion).toBe(DEFAULT_RECIPE.version);
    });
  });

  it("sends the subtask's prompt and verbatim references to the child", async () => {
    await runInDurableObject(freshStub("exec-request"), async (instance) => {
      const references = [{ role: "user" as const, text: "the exact turn" }];
      const { rows } = seed(instance, [draft({ references })]);
      const { executeSpy } = stubChild(instance, async () => OK);

      await instance.executeSubtaskChunk(rows[0].id, 0);

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

      await instance.executeSubtaskChunk(rows[0].id, 0);

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

      await instance.executeSubtaskChunk(rows[2].id, 0);

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

      const done = await exec(instance, rows[0].id);
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

      const done = await exec(instance, rows[0].id);
      expect(done.status).toBe("failed");
      expect(done.error).toContain("malformed result");
    });
  });
});

describe("executeSubtaskChunk — retry and recovery", () => {
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
      const done = await exec(instance, rows[0].id);

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
      await instance.executeSubtaskChunk(rows[0].id, 0);

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

      const done = await exec(instance, rows[0].id);

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

      await expect(instance.executeSubtaskChunk(rows[0].id, 0)).rejects.toThrow(
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

      await expect(instance.executeSubtaskChunk(rows[0].id, 0)).rejects.toThrow(
        /3040/
      );
      // Left running for the step retry to resume.
      expect((await instance.listSubtasks(TASK_ID))[0].status).toBe("running");
    });
  });

  it("throws on an unknown subtask", async () => {
    await runInDurableObject(freshStub("exec-unknown"), async (instance) => {
      await expect(instance.executeSubtaskChunk(9999, 0)).rejects.toThrow(
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

      await expect(instance.executeSubtaskChunk(rows[1].id, 0)).rejects.toThrow(
        /ran before dependency/
      );
    });
  });
});

describe("executeSubtaskChunk — cancellation", () => {
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

      const row = await exec(instance, rows[0].id);
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

        const row = await exec(instance, rows[0].id);

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

        const row = await exec(instance, rows[0].id);

        expect(row.status).toBe("canceled");
        expect(row.resultParts).toBeNull();
        expect(deleteSubAgent).toHaveBeenCalled();
      }
    );
  });

  // An aborted run yields rather than producing a terminal result. Resolving it
  // here — instead of waiting for the next chunk's `prepareChunk` to notice —
  // costs one fewer round trip and, more importantly, keeps the progress the
  // chunk emitted from being published for a task the caller abandoned.
  it("resolves a yielding chunk and publishes nothing once canceled", async () => {
    await runInDurableObject(
      freshStub("exec-cancel-yield"),
      async (instance) => {
        const { rows } = seed(instance, [draft()]);
        await instance.beginTask({
          messageId: "m1",
          taskId: TASK_ID,
          contextId: "c1"
        });

        const posted: string[] = [];
        vi.spyOn(
          instance as unknown as {
            postWorking: (...a: unknown[]) => Promise<void>;
          },
          "postWorking"
        ).mockImplementation(async (...a: unknown[]) => {
          posted.push(String(a[2]));
        });

        // The chunk is interrupted mid-flight: it yields with progress already
        // emitted, exactly as an aborted `runResumableChunk` does.
        const abortExecution = vi.fn().mockResolvedValue(undefined);
        const executeChunk = vi.fn(async (): Promise<RecipeChunkResult> => {
          await instance.cancelTask(TASK_ID);
          return {
            done: false,
            progress: [{ key: "step:0", text: "half a move" }]
          };
        });
        vi.spyOn(instance, "subAgent").mockResolvedValue({
          executeChunk,
          abortExecution
        } as never);
        const deleteSubAgent = vi
          .spyOn(instance, "deleteSubAgent")
          .mockResolvedValue(undefined);

        const outcome = await instance.executeSubtaskChunk(rows[0].id, 0, {
          taskId: TASK_ID,
          contextId: "c1",
          pushUrl: "https://gw.example.com/a2a/notifications",
          pushToken: "tok",
          jku: "https://agent.example.com/.well-known/jwks.json"
        });

        // Terminal in this same call — no further chunk is requested.
        expect(outcome.done).toBe(true);
        expect(outcome.status).toBe("canceled");
        expect(posted).toEqual([]);
        expect(abortExecution).toHaveBeenCalled();
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

      const after = await scanNodes(instance);
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

      const after = await scanNodes(instance);
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

        const after = await scanNodes(instance);
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

      const after = await scanNodes(instance);
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

      const after = await scanNodes(instance);
      expect(after[1].status).toBe("pending");
    });
  });

  it("sees only its own round's nodes", async () => {
    await runInDurableObject(freshStub("skip-round"), async (instance) => {
      const { rows, db } = seed(instance, [draft({ localKey: "a" })]);
      db.subtasks.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      db.subtasks.fail(rows[0].id, "boom");
      seed(instance, [draft({ localKey: "b" })], 1);

      // Round 1's node does not depend on round 0's failure, so it stays
      // runnable — and round 0's terminal row never enters round 1's wave, where
      // the scheduler would have to reason about it.
      const round1 = await scanNodes(instance, 1);
      expect(round1.map((n) => n.status)).toEqual(["pending"]);
      const round0 = await scanNodes(instance, 0);
      expect(round0.map((n) => n.status)).toEqual(["failed"]);
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

describe("executeSubtaskChunk — real facet integration", () => {
  it("records a terminal failure and leaves no child behind", async () => {
    await runInDurableObject(freshStub("exec-real"), async (instance) => {
      const { rows } = seed(instance, [draft()]);

      // No stubbing: a real RecipeSubagent facet runs. env.AI has no local mode,
      // so the child exhausts both models and returns a terminal failure — which
      // is exactly the parent path we want proven end-to-end.
      const done = await exec(instance, rows[0].id);

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
