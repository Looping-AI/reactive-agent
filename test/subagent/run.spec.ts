/**
 * The subagent runner (src/subagent/run.ts). One source file, two layers:
 *
 *   - `runResumableChunk` — the engine: one durable chunk of the model/tool loop,
 *     covering single-chunk completion, multi-chunk yield + resume, turn-budget
 *     exhaustion → summary, per-turn checkpointing, and progress ending a chunk.
 *   - `runRecipeExecution` — the in-memory driver over that engine: whole-run
 *     outcomes, primary → fallback recovery, and the transient-vs-deterministic
 *     split (platform faults throw for Workflow retry; everything else is terminal).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  runResumableChunk,
  runRecipeExecution,
  type ChunkRunDeps,
  type ChunkRunState
} from "@/subagent/run";
import type { ModelPair } from "@/agent/model";
import type { ProgressEvent, RecipeLimits } from "@/agent/subtasks/types";
import { mockModel, type MockStep } from "../agent/mock-model";
import { makeRequest } from "./fixtures";

/** A `ModelPair` from raw factory functions. Error paths throw *from the factory*
 * (the repo convention — a rejecting `doGenerate` leaks an unhandled rejection
 * through the AI SDK telemetry span that workerd flags as a failure). */
function modelPair(
  primary: () => LanguageModel,
  fallback: () => LanguageModel
): ModelPair {
  return {
    primary,
    fallback,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model"
  };
}

/** A `ModelPair` whose both slots return the same scripted model instance. */
function pairOf(model: LanguageModel): ModelPair {
  return modelPair(
    () => model,
    () => model
  );
}

/** Minimal real tool exercising the multi-step tool-call loop. */
const ECHO: ToolSet = {
  echo: tool({
    description: "echo",
    inputSchema: z.object({}),
    execute: async () => "ok"
  })
};

const CALL_ECHO: MockStep = { toolCall: { toolName: "echo", input: {} } };

/** A model whose only reply is truncated (finish_reason=length). */
function truncatedModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "partial" }],
      finishReason: { unified: "length" as const, raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 }
      },
      warnings: []
    })
  });
}

describe("runResumableChunk", () => {
  function deps(over: {
    model: LanguageModel;
    tools?: ToolSet;
    limits?: Partial<RecipeLimits>;
    reportMetrics?: boolean;
    progress?: ProgressEvent[];
  }): ChunkRunDeps {
    return {
      system: "sys",
      seedPrompt: "Do the work.",
      models: pairOf(over.model),
      tools: over.tools ?? {},
      limits: {
        maxTurns: over.limits?.maxTurns ?? 8,
        turnsPerChunk: over.limits?.turnsPerChunk ?? 8,
        chunkSoftMs: over.limits?.chunkSoftMs ?? 10 * 60_000
      },
      historyWindow: 64,
      reportMetrics: over.reportMetrics ?? false,
      now: () => 1000,
      progress: over.progress ?? [],
      checkpoint: () => {}
    };
  }

  it("completes in a single chunk on a final reply", async () => {
    const out = await runResumableChunk(
      null,
      deps({ model: mockModel({ text: "the answer" }) })
    );
    expect(out.outcome.done).toBe(true);
    if (!out.outcome.done) return;
    expect(out.outcome.result).toEqual({
      status: "completed",
      resultParts: [{ kind: "text", text: "the answer" }],
      modelId: "primary-model"
    });
  });

  it("appends a metrics footer only when reportMetrics is set", async () => {
    const out = await runResumableChunk(
      null,
      deps({ model: mockModel({ text: "done" }), reportMetrics: true })
    );
    expect(out.outcome.done && out.outcome.result.status).toBe("completed");
    if (out.outcome.done && out.outcome.result.status === "completed") {
      expect(out.outcome.result.resultParts[0].text).toContain("done");
      expect(out.outcome.result.resultParts[0].text).toMatch(
        /Ran \d+ model turn/
      );
    }
  });

  it("yields across chunks and resumes, then summarizes at the turn budget", async () => {
    // 4 tool-call turns then a final report; budget is 4 turns, 2 per chunk.
    const model = mockModel(CALL_ECHO, CALL_ECHO, CALL_ECHO, CALL_ECHO, {
      text: "final report"
    });
    const d = deps({
      model,
      tools: ECHO,
      limits: { maxTurns: 4, turnsPerChunk: 2 }
    });

    // Chunk 0: runs 2 turns, then yields (not done).
    const first = await runResumableChunk(null, d);
    expect(first.outcome.done).toBe(false);
    expect(first.state.turns).toBe(2);

    // Chunk 1: resumes from the checkpoint, hits the 4-turn budget, and the
    // budget-exhaustion summary produces the terminal result.
    const second = await runResumableChunk(first.state, d);
    expect(second.outcome.done).toBe(true);
    if (!second.outcome.done) return;
    expect(second.outcome.result.status).toBe("completed");
    if (second.outcome.result.status === "completed") {
      expect(second.outcome.result.resultParts[0].text).toBe("final report");
    }
    expect(second.state.turns).toBe(4);
  });

  it("resumes at the turn ceiling straight into the summary, running no extra turn", async () => {
    // A retry can re-enter with turns == maxTurns (checkpoint taken on the final
    // allowed turn, before the chunk returned). The chunk must summarize, never
    // run another (unbudgeted, side-effecting) tool turn.
    let echoCalls = 0;
    const spyTools: ToolSet = {
      echo: tool({
        description: "echo",
        inputSchema: z.object({}),
        execute: async () => {
          echoCalls += 1;
          return "ok";
        }
      })
    };
    // The model would emit a tool call if asked — proves the guard prevented it.
    const model = mockModel(CALL_ECHO, { text: "final report" });
    const d = deps({ model, tools: spyTools, limits: { maxTurns: 2 } });
    const resumed: ChunkRunState = {
      messages: [{ role: "user", content: "Do the work." }],
      turns: 2,
      llmCalls: 4,
      startedAtMs: 500
    };

    const out = await runResumableChunk(resumed, d);

    expect(out.outcome.done).toBe(true);
    if (!out.outcome.done) return;
    expect(out.outcome.result.status).toBe("completed");
    if (out.outcome.result.status === "completed") {
      expect(out.outcome.result.resultParts[0].text).toBe("final report");
    }
    // No extra turn executed and no tool side effect.
    expect(out.state.turns).toBe(2);
    expect(echoCalls).toBe(0);
  });

  it("ends a chunk as soon as a tool emits a progress event", async () => {
    const progress: ProgressEvent[] = [];
    const tools: ToolSet = {
      level_up: tool({
        description: "emits progress",
        inputSchema: z.object({}),
        execute: async () => {
          progress.push({ key: "arc:level:1", text: "level 1" });
          return "leveled up";
        }
      })
    };
    const model = mockModel(
      { toolCall: { toolName: "level_up", input: {} } },
      { text: "should not be reached this chunk" }
    );
    const out = await runResumableChunk(
      null,
      deps({
        model,
        tools,
        limits: { maxTurns: 20, turnsPerChunk: 20 },
        progress
      })
    );

    expect(out.outcome.done).toBe(false);
    expect(out.outcome.progress).toEqual([
      { key: "arc:level:1", text: "level 1" }
    ]);
    expect(out.state.turns).toBe(1);
  });

  it("checkpoints after every turn", async () => {
    const saved: ChunkRunState[] = [];
    const d = deps({
      model: mockModel(CALL_ECHO, CALL_ECHO, { text: "done" }),
      tools: ECHO,
      limits: { maxTurns: 8, turnsPerChunk: 8 }
    });
    d.checkpoint = (s) => {
      saved.push({ ...s });
    };
    await runResumableChunk(null, d);
    // One checkpoint per turn: two tool-call turns + the final reply turn.
    expect(saved.length).toBe(3);
    expect(saved.map((s) => s.turns)).toEqual([1, 2, 3]);
  });
});

describe("runRecipeExecution", () => {
  function run(pair: ModelPair, tools: ToolSet = {}) {
    return runRecipeExecution(makeRequest(), { models: pair, tools });
  }

  it("completes on the primary model with a text result part", async () => {
    const result = await run(
      modelPair(
        () => mockModel({ text: "the answer" }),
        () => {
          throw new Error("fallback must not be reached");
        }
      )
    );
    expect(result).toEqual({
      status: "completed",
      resultParts: [{ kind: "text", text: "the answer" }],
      modelId: "primary-model"
    });
  });

  it("runs the bounded tool loop (tool call step, then final text)", async () => {
    const result = await run(
      modelPair(
        () =>
          mockModel(
            { toolCall: { toolName: "echo", input: { text: "ping" } } },
            { text: "echoed" }
          ),
        () => {
          throw new Error("fallback must not be reached");
        }
      ),
      {
        echo: tool({
          description: "Echoes its input back.",
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => text
        })
      }
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.resultParts).toEqual([{ kind: "text", text: "echoed" }]);
    }
  });

  it("falls back when the primary throws (non-transient)", async () => {
    const result = await run(
      modelPair(
        () => {
          throw new Error("primary exploded");
        },
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(result).toEqual({
      status: "completed",
      resultParts: [{ kind: "text", text: "from fallback" }],
      modelId: "fallback-model"
    });
  });

  it("falls back when the primary returns a blank reply", async () => {
    const result = await run(
      modelPair(
        () => mockModel({ text: "   " }),
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.modelId).toBe("fallback-model");
    }
  });

  it("falls back when the primary reply is truncated (finish_reason=length)", async () => {
    const result = await run(
      modelPair(
        () => truncatedModel(),
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(result.status).toBe("completed");
  });

  it("returns a terminal failure with both diagnostics when both replies are blank", async () => {
    const result = await run(
      modelPair(
        () => mockModel({ text: "" }),
        () => mockModel({ text: "" })
      )
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("recipe exhausted");
      expect(result.error).toContain("primary (primary-model)");
      expect(result.error).toContain("fallback (fallback-model)");
      expect(result.modelId).toBe("fallback-model");
    }
  });

  it("returns a terminal failure when both models fail non-transiently", async () => {
    const result = await run(
      modelPair(
        () => {
          throw new Error("bad model config");
        },
        () => {
          throw new Error("also bad");
        }
      )
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("bad model config");
      expect(result.error).toContain("also bad");
    }
  });

  it("throws when the primary fault is transient and the fallback also fails", async () => {
    await expect(
      run(
        modelPair(
          () => {
            throw new Error("3040: capacity temporarily exceeded");
          },
          () => {
            throw new Error("also bad");
          }
        )
      )
    ).rejects.toThrow("3040");
  });

  it("throws when the fallback fault is transient", async () => {
    await expect(
      run(
        modelPair(
          () => {
            throw new Error("bad model config");
          },
          () => {
            throw new Error("request timeout");
          }
        )
      )
    ).rejects.toThrow("request timeout");
  });

  it("fails an empty prompt immediately with zero model invocations", async () => {
    let factoryCalls = 0;
    const counting = () => {
      factoryCalls++;
      return mockModel({ text: "never" }) as LanguageModel;
    };
    const result = await runRecipeExecution(makeRequest({ prompt: "   " }), {
      models: modelPair(counting, counting),
      tools: {}
    });
    expect(result).toEqual({
      status: "failed",
      error: "empty subtask prompt",
      modelId: null
    });
    expect(factoryCalls).toBe(0);
  });
});
