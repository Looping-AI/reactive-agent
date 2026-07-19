/**
 * RecipeSubagent (src/subagent/index.ts): retry-safe execution against real
 * facet SQLite. Two tiers — direct instances via the test-only RECIPE_SUBAGENT
 * binding (so a `ModelPair` can be injected), and the facet lifecycle beneath
 * the real `ReactiveAgent` parent, which doubles as the integration proof that
 * facets work under the Workers Vitest pool with no production binding.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { LanguageModel } from "ai";
import { FINGERPRINT_MISMATCH, RecipeSubagent, subagentName } from "@/subagent";
import type { ModelPair } from "@/agent/model";
import type {
  RecipeExecutionRequest,
  RecipeExecutionResult
} from "@/agent/subtasks/types";
import { DEFAULT_RECIPE } from "@/agent/subtasks/registry";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import { mockModel } from "../agent/mock-model";
import { makeRequest } from "./fixtures";
import { freshStub } from "../helpers/do";

/** Fresh, unique child DO per test (mirrors helpers/do.ts `freshStub`). */
function freshChild(label: string) {
  const ns = env.RECIPE_SUBAGENT;
  if (!ns) {
    throw new Error(
      "test-only RECIPE_SUBAGENT binding missing — see vitest.config.ts"
    );
  }
  return ns.get(ns.idFromName(`test:${label}:${crypto.randomUUID()}`));
}

/**
 * A `ModelPair` from raw factories, counting factory invocations — one per
 * `generateText` attempt (the raw pair does not memoize) — so cache-reuse
 * assertions count inference by construction, not timing.
 */
function countingPair(
  primary: () => LanguageModel,
  fallback: () => LanguageModel
): ModelPair & { attempts: () => number } {
  let attempts = 0;
  return {
    primary: () => {
      attempts++;
      return primary();
    },
    fallback: () => {
      attempts++;
      return fallback();
    },
    primaryId: () => CHAT_MODEL_ID,
    fallbackId: () => CHAT_FALLBACK_MODEL_ID,
    attempts: () => attempts
  };
}

/**
 * Drive a single-chunk execution to its terminal result. The default recipe
 * (`maxTurns === turnsPerChunk`) always completes on chunk 0, so a done outcome
 * carries the terminal result the old `execute` used to return directly.
 */
async function terminal(
  child: RecipeSubagent,
  request: RecipeExecutionRequest
): Promise<RecipeExecutionResult> {
  const out = await child.executeChunk(request, 0);
  if (!out.done) throw new Error("expected a single-chunk terminal outcome");
  return out.result;
}

describe("subagentName", () => {
  it("is deterministic per (taskId, subtaskId)", () => {
    expect(subagentName("task-9", 3)).toBe("subtask:task-9:3");
  });
});

describe("RecipeSubagent.executeChunk", () => {
  it("completes, caches the terminal result, and replays it without inference", async () => {
    await runInDurableObject(freshChild("complete"), async (child) => {
      const pair = countingPair(
        () => mockModel({ text: "the answer" }),
        () => {
          throw new Error("fallback must not be reached");
        }
      );
      child.modelsOverride = pair;

      const result = await terminal(child, makeRequest());
      expect(result).toEqual({
        status: "completed",
        resultParts: [{ kind: "text", text: "the answer" }],
        modelId: CHAT_MODEL_ID
      });
      expect(pair.attempts()).toBe(1);

      const again = await terminal(child, makeRequest());
      expect(again).toEqual(result);
      expect(pair.attempts()).toBe(1);
    });
  });

  it("caches a deterministic failure — a step retry does not re-run inference", async () => {
    await runInDurableObject(freshChild("failed"), async (child) => {
      const pair = countingPair(
        () => {
          throw new Error("bad model config");
        },
        () => {
          throw new Error("also bad");
        }
      );
      child.modelsOverride = pair;

      const result = await terminal(child, makeRequest());
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("recipe exhausted");
      }
      expect(pair.attempts()).toBe(2);

      const again = await terminal(child, makeRequest());
      expect(again).toEqual(result);
      expect(pair.attempts()).toBe(2);
    });
  });

  it("rejects a different request for the same child, keeping the cached result", async () => {
    await runInDurableObject(freshChild("mismatch"), async (child) => {
      child.modelsOverride = countingPair(
        () => mockModel({ text: "original" }),
        () => {
          throw new Error("fallback must not be reached");
        }
      );

      const original = await terminal(child, makeRequest());
      await expect(
        terminal(child, makeRequest({ prompt: "A different task." }))
      ).rejects.toThrow(FINGERPRINT_MISMATCH);
      expect(await terminal(child, makeRequest())).toEqual(original);
    });
  });

  it("caches nothing on a transient fault — an identical retry re-runs inference", async () => {
    await runInDurableObject(freshChild("transient"), async (child) => {
      child.modelsOverride = countingPair(
        () => {
          throw new Error("3040: capacity temporarily exceeded");
        },
        () => {
          throw new Error("also down");
        }
      );
      await expect(terminal(child, makeRequest())).rejects.toThrow("3040");

      // The fault left no cached result: the same request now succeeds.
      const pair = countingPair(
        () => mockModel({ text: "recovered" }),
        () => {
          throw new Error("fallback must not be reached");
        }
      );
      child.modelsOverride = pair;
      const result = await terminal(child, makeRequest());
      expect(result.status).toBe("completed");
      expect(pair.attempts()).toBe(1);
    });
  });

  it("fails a disabled recipe terminally with zero model calls (defensive re-validation)", async () => {
    await runInDurableObject(freshChild("disabled"), async (child) => {
      const pair = countingPair(
        () => mockModel({ text: "never" }),
        () => mockModel({ text: "never" })
      );
      child.modelsOverride = pair;

      const request = makeRequest({
        recipe: { ...DEFAULT_RECIPE, enabled: false }
      });
      const result = await terminal(child, request);
      expect(result).toEqual({
        status: "failed",
        error: expect.stringContaining("disabled") as string,
        modelId: null
      });
      expect(pair.attempts()).toBe(0);

      // Deterministic, so cached like any terminal outcome.
      expect(await terminal(child, request)).toEqual(result);
    });
  });

  it("substitutes non-allowlisted model ids before building the pair", async () => {
    await runInDurableObject(freshChild("allowlist"), async (child) => {
      // No override: the validated ids flow into createModelPair. The real
      // Workers-AI binding has no local mode, so both attempts fail and the
      // diagnostics reveal which ids were actually used.
      const result = await terminal(
        child,
        makeRequest({
          recipe: {
            ...DEFAULT_RECIPE,
            primaryModelId: "@cf/evil/injected",
            fallbackModelId: "@cf/evil/injected-2"
          }
        })
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain(`primary (${CHAT_MODEL_ID})`);
        expect(result.error).toContain(`fallback (${CHAT_FALLBACK_MODEL_ID})`);
        expect(result.error).not.toContain("@cf/evil");
      }
    });
  });
});

describe("RecipeSubagent facet lifecycle", () => {
  it("creates, executes, caches, deletes, and re-creates with wiped storage", async () => {
    await runInDurableObject(freshStub("facet"), async (instance) => {
      const name = subagentName("task-1", 1);
      const child = await instance.subAgent(RecipeSubagent, name);

      // No model injection through the facet stub: the real Workers-AI path
      // fails gracefully (env.AI has no local mode), exercising the
      // deterministic recipe-exhausted terminal path end-to-end.
      const chunk = await child.executeChunk(makeRequest(), 0);
      expect(chunk.done).toBe(true);
      const result = chunk.done ? chunk.result : undefined;
      expect(result?.status).toBe("failed");
      const replay = await child.executeChunk(makeRequest(), 0);
      expect(replay.done && replay.result).toEqual(result);

      // Settle the RPC promise into a plain one before asserting. A stub call
      // returns workerd's RpcPromise, whose property access is pipelined into
      // further RPC calls — letting `expect().rejects` inspect it spawns
      // pipelined promises that reject with no handler, which Vitest reports as
      // an unhandled rejection and fails the run on.
      const mismatch = await child
        .executeChunk(makeRequest({ prompt: "A different task." }), 0)
        .then(
          () => undefined,
          (err: unknown) => err
        );
      expect(String(mismatch)).toContain(FINGERPRINT_MISMATCH);

      expect(instance.hasSubAgent(RecipeSubagent, name)).toBe(true);
      expect(instance.listSubAgents(RecipeSubagent).map((s) => s.name)).toEqual(
        [name]
      );

      await instance.deleteSubAgent(RecipeSubagent, name);
      // Idempotent: deleting an already-deleted child is a no-op.
      await instance.deleteSubAgent(RecipeSubagent, name);
      expect(instance.hasSubAgent(RecipeSubagent, name)).toBe(false);
      expect(instance.listSubAgents(RecipeSubagent)).toEqual([]);

      // Deletion wiped the child's storage: the request that mismatched above
      // now executes fresh on the re-created child instead of rejecting.
      const recreated = await instance.subAgent(RecipeSubagent, name);
      const fresh = await recreated.executeChunk(
        makeRequest({ prompt: "A different task." }),
        0
      );
      expect(fresh.done && fresh.result.status).toBe("failed");
      await instance.deleteSubAgent(RecipeSubagent, name);
    });
  });
});
