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
import type { LanguageModel, ModelMessage, ToolResultPart, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  runResumableChunk,
  runRecipeExecution,
  elideToolOutputs,
  windowMessages,
  ELIDED_TOOL_OUTPUT,
  type ChunkRunDeps,
  type ChunkRunState
} from "@/subagent/run";
import type { ModelPair } from "@/agent/model";
import type { ProgressEvent } from "@/agent/subtasks/types";
import type { RecipeLimits } from "@/recipes/types";
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
    abortSignal?: AbortSignal;
    models?: ModelPair;
    now?: () => number;
    chunkSoftMs?: number;
    toolOutputWindow?: number;
  }): ChunkRunDeps {
    return {
      system: "sys",
      seedPrompt: "Do the work.",
      models: over.models ?? pairOf(over.model),
      tools: over.tools ?? {},
      limits: {
        maxTurns: over.limits?.maxTurns ?? 8,
        // Far past the fixed clock below, so the wall clock never binds unless a
        // case sets out to exercise it.
        maxWallMs: over.limits?.maxWallMs ?? 60 * 60_000
      },
      chunkSoftMs: over.chunkSoftMs ?? 10 * 60_000,
      historyWindow: 64,
      // Wide enough that elision never fires incidentally — the cases that care
      // about it exercise `elideToolOutputs` directly.
      toolOutputWindow: over.toolOutputWindow ?? 64,
      reportMetrics: over.reportMetrics ?? false,
      now: over.now ?? (() => 1000),
      progress: over.progress ?? [],
      checkpoint: () => {},
      abortSignal: over.abortSignal
    };
  }

  // Cancellation. The rule under test: an abort is *not* a model failure. It must
  // not spend the fallback model, and it must not produce a terminal result — a
  // cached `failed` would replay forever on every later retry.
  describe("abort", () => {
    it("makes no model call at all when already aborted", async () => {
      let calls = 0;
      const model = mockModel({ text: "should never run" });
      const orig = model.doGenerate.bind(model);
      model.doGenerate = async (o: Parameters<typeof orig>[0]) => {
        calls++;
        return orig(o);
      };

      const out = await runResumableChunk(
        null,
        deps({ model, abortSignal: AbortSignal.abort() })
      );

      expect(calls).toBe(0);
      expect(out.outcome.done).toBe(false);
    });

    it("yields without trying the fallback when aborted mid-call", async () => {
      const controller = new AbortController();
      const ids: string[] = [];
      // Both slots are distinguishable, so a fallback attempt would show up.
      const make = (id: string) =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            ids.push(id);
            controller.abort();
            throw new DOMException("Aborted", "AbortError");
          }
        });
      const primary = make("primary");
      const fallback = make("fallback");

      const out = await runResumableChunk(
        null,
        deps({
          model: primary,
          models: modelPair(
            () => primary,
            () => fallback
          ),
          abortSignal: controller.signal
        })
      );

      expect(ids).toEqual(["primary"]);
      expect(out.outcome.done).toBe(false);
      expect(out.outcome).not.toHaveProperty("result");
    });

    it("yields instead of summarizing when aborted at the turn budget", async () => {
      // turns === maxTurns on entry would normally force the budget summary.
      const state: ChunkRunState = {
        messages: [{ role: "user", content: "Do the work." }],
        turns: 4,
        llmCalls: 4,
        startedAtMs: 0
      };
      let calls = 0;
      const model = mockModel({ text: "summary" });
      const orig = model.doGenerate.bind(model);
      model.doGenerate = async (o: Parameters<typeof orig>[0]) => {
        calls++;
        return orig(o);
      };

      const out = await runResumableChunk(
        state,
        deps({
          model,
          limits: { maxTurns: 4 },
          abortSignal: AbortSignal.abort()
        })
      );

      expect(calls).toBe(0);
      expect(out.outcome.done).toBe(false);
    });
  });

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
    // 4 tool-call turns then a final report, against a 4-turn budget. What ends
    // chunk 0 early is `chunkSoftMs` — the step-timeout guard, the only thing
    // that slices a run now that no turn-per-chunk allowance exists. The clock
    // advances a minute per read, so the 90s soft limit trips after 2 turns.
    let clock = 0;
    const model = mockModel(CALL_ECHO, CALL_ECHO, CALL_ECHO, CALL_ECHO, {
      text: "final report"
    });
    const d = deps({
      model,
      tools: ECHO,
      limits: { maxTurns: 4 },
      chunkSoftMs: 90_000,
      now: () => (clock += 60_000)
    });

    // Chunk 0 yields on the soft limit rather than completing.
    const first = await runResumableChunk(null, d);
    expect(first.outcome.done).toBe(false);
    expect(first.state.turns).toBeGreaterThan(0);
    expect(first.state.turns).toBeLessThan(4);

    // Drive the rest the way the Workflow does, resuming from each checkpoint,
    // until the 4-turn budget forces the summary that terminates the run.
    let state = first.state;
    let chunks = 1;
    let result;
    for (; chunks < 10; chunks++) {
      const next = await runResumableChunk(state, d);
      state = next.state;
      if (next.outcome.done) {
        result = next.outcome.result;
        break;
      }
    }

    expect(chunks).toBeGreaterThan(1); // it really did span chunks
    expect(result?.status).toBe("completed");
    if (result?.status === "completed") {
      expect(result.resultParts[0].text).toBe("final report");
    }
    expect(state.turns).toBe(4);
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

  // The wall clock is the budget that stops a *slow* run — the one whose turn
  // counter still looks healthy after hours, because a turn here is a reasoning
  // model plus an HTTP round trip rather than the fast turn a turn budget assumes.
  describe("wall-clock budget", () => {
    it("summarizes on entry when the deadline passed, running no extra turn", async () => {
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
      // The model would happily emit another tool call — proving the guard, not
      // the model, is what stopped the run.
      const model = mockModel(CALL_ECHO, { text: "final report" });
      const d = deps({
        model,
        tools: spyTools,
        // Turns are nowhere near spent: only time is.
        limits: { maxTurns: 1_000, maxWallMs: 20 * 60_000 },
        now: () => 21 * 60_000
      });
      const resumed: ChunkRunState = {
        messages: [{ role: "user", content: "Do the work." }],
        turns: 37,
        llmCalls: 40,
        startedAtMs: 0
      };

      const out = await runResumableChunk(resumed, d);

      expect(out.outcome.done).toBe(true);
      if (!out.outcome.done) return;
      expect(out.outcome.result.status).toBe("completed");
      if (out.outcome.result.status === "completed") {
        expect(out.outcome.result.resultParts[0].text).toBe("final report");
      }
      // The ceiling yields a report, not a dropped run — and costs no tool turn.
      expect(out.state.turns).toBe(37);
      expect(echoCalls).toBe(0);
    });

    it("ends the in-flight chunk at the deadline rather than at chunkSoftMs", async () => {
      // Clock advances a minute per read, so the run crosses its 3-minute
      // deadline mid-chunk while the turn budget (1,000) and chunkSoftMs (10m)
      // have plenty of room left.
      let clock = 0;
      const model = mockModel(
        CALL_ECHO,
        CALL_ECHO,
        CALL_ECHO,
        CALL_ECHO,
        CALL_ECHO,
        { text: "final report" }
      );
      const d = deps({
        model,
        tools: ECHO,
        limits: { maxTurns: 1_000, maxWallMs: 3 * 60_000 },
        now: () => (clock += 60_000)
      });

      const out = await runResumableChunk(null, d);

      // Terminal via the summary, well short of both the turn and chunk budgets.
      expect(out.outcome.done).toBe(true);
      expect(out.state.turns).toBeLessThan(10);
    });

    it("leaves a run under both budgets alone", async () => {
      const model = mockModel(CALL_ECHO, { text: "final report" });
      const out = await runResumableChunk(
        null,
        deps({
          model,
          tools: ECHO,
          limits: { maxTurns: 8, maxWallMs: 20 * 60_000 },
          now: () => 1000
        })
      );

      expect(out.outcome.done).toBe(true);
      if (!out.outcome.done) return;
      expect(out.outcome.result.status).toBe("completed");
      if (out.outcome.result.status === "completed") {
        expect(out.outcome.result.resultParts[0].text).toBe("final report");
      }
      expect(out.state.turns).toBe(2);
    });
  });

  it("charges the fallback for what the primary already spent", async () => {
    // `isStepCount` counts within one `generateText` call, so a `stopWhen` built
    // once per chunk and shared with the fallback would hand it the allowance the
    // primary had already used. Running out of steps is normally a *yield* here
    // rather than a failure, which hid this — it only surfaces when the primary
    // does real work and then genuinely fails.
    const primary = () => mockModel(CALL_ECHO, CALL_ECHO, { text: "" });
    const fallback = () =>
      mockModel(...Array.from({ length: 10 }, () => CALL_ECHO));

    const out = await runResumableChunk(
      null,
      deps({
        model: primary(),
        models: modelPair(primary, fallback),
        tools: ECHO,
        limits: { maxTurns: 5 }
      })
    );

    // 3 spent failing, 2 left for the fallback — not another full 5.
    expect(out.state.turns).toBe(5);
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
        limits: { maxTurns: 20 },
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
      limits: { maxTurns: 8 }
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

/**
 * The other half of the rolling window: `windowMessages` decides how many turns
 * survive, `elideToolOutputs` decides what a surviving turn costs. The rules that
 * matter are the ones that keep an *old* result — losing the wrong one is not a
 * context saving, it is a model acting on something it can no longer see.
 */
describe("elideToolOutputs", () => {
  const BIG = "x".repeat(500);

  /** One turn: an assistant tool call and the result that answered it. */
  function turn(
    id: string,
    toolName: string,
    output: ToolResultPart["output"] = { type: "text", value: BIG }
  ): ModelMessage[] {
    return [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: id, toolName, input: { note: id } }
        ]
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName, output }]
      }
    ];
  }

  /** Every tool-result output in order, for compact assertions. */
  function outputs(messages: ModelMessage[]): unknown[] {
    return messages
      .filter((m) => m.role === "tool")
      .flatMap((m) =>
        (m.content as ToolResultPart[])
          .filter((p) => p.type === "tool-result")
          .map((p) => (p.output.type === "text" ? p.output.value : p.output))
      );
  }

  it("stubs a result the model has moved past", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "inspect"),
      ...turn("b", "act"),
      ...turn("c", "act")
    ];
    // Only the last assistant turn keeps its detail; `a` is old, and `b` is no
    // longer the newest `act`.
    expect(outputs(elideToolOutputs(messages, 1))).toEqual([
      BIG, // rule 2: still the newest `inspect`
      ELIDED_TOOL_OUTPUT,
      BIG
    ]);
  });

  // The regression this rule exists for: `arc_inspect` answers a repeated view of
  // an unchanged board with "what you saw then still holds", which is only true
  // while the render it points at is in context. Age alone would elide it.
  it("keeps the newest result for each tool however old it is", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "inspect"),
      ...turn("b", "act"),
      ...turn("c", "act"),
      ...turn("d", "act")
    ];
    const [inspect] = outputs(elideToolOutputs(messages, 1));
    expect(inspect).toBe(BIG);
  });

  it("keeps a failure, which is short and says why", () => {
    const err = { type: "error-text" as const, value: "y".repeat(500) };
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "act", err),
      ...turn("b", "act"),
      ...turn("c", "act")
    ];
    expect(outputs(elideToolOutputs(messages, 1))[0]).toEqual(err);
  });

  it("leaves a small result alone, since the stub would be most of it", () => {
    const small = { type: "text" as const, value: "ok" };
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "act", small),
      ...turn("b", "act"),
      ...turn("c", "act")
    ];
    expect(outputs(elideToolOutputs(messages, 1))[0]).toBe("ok");
  });

  it("preserves ids, names, order and the tool calls themselves", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "act"),
      ...turn("b", "act"),
      ...turn("c", "act")
    ];
    const out = elideToolOutputs(messages, 1);
    expect(out).toHaveLength(messages.length);
    expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
    // The call side is untouched — that is where the model's own notes live.
    expect(out[1]).toEqual(messages[1]);
    const stubbed = (out[2] as { content: ToolResultPart[] }).content[0];
    expect(stubbed.toolCallId).toBe("a");
    expect(stubbed.toolName).toBe("act");
  });

  it("is idempotent — a stub is small enough to survive the next pass", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "act"),
      ...turn("b", "act"),
      ...turn("c", "act")
    ];
    const once = elideToolOutputs(messages, 1);
    expect(elideToolOutputs(once, 1)).toEqual(once);
  });

  it("returns the input unchanged when nothing needs eliding", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "act")
    ];
    expect(elideToolOutputs(messages, 4)).toBe(messages);
  });

  it("composes with windowMessages without orphaning a tool result", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...turn("a", "act"),
      ...turn("b", "act"),
      ...turn("c", "act")
    ];
    const out = elideToolOutputs(windowMessages(messages, 2), 1);
    // Every surviving tool-result still has the assistant call it answers.
    const callIds = new Set(
      out
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          (m.content as { type: string; toolCallId?: string }[])
            .filter((p) => p.type === "tool-call")
            .map((p) => p.toolCallId)
        )
    );
    for (const m of out.filter((m) => m.role === "tool")) {
      for (const p of m.content as ToolResultPart[]) {
        expect(callIds.has(p.toolCallId)).toBe(true);
      }
    }
  });
});
