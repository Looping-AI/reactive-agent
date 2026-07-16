/**
 * The Session-less recipe run loop (src/subagent/run.ts): bounded tool loop,
 * primary → fallback recovery, and the transient-vs-deterministic split —
 * platform faults throw (Workflow retries), everything else is a terminal
 * result.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { runRecipeExecution } from "@/subagent/run";
import type { ModelPair } from "@/agent/model";
import { mockModel } from "../agent/mock-model";
import { makeRequest } from "./fixtures";

/** Minimal real tool exercising the multi-step tool-call loop. */
const ECHO_TOOL: ToolSet = {
  echo: tool({
    description: "Echoes its input back.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => text
  })
};

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

/**
 * Build a `ModelPair` from raw factory functions. Error paths throw *from the
 * factory* (the repo convention — a rejecting `doGenerate` leaks an unhandled
 * rejection through the AI SDK telemetry span that workerd flags as a failure).
 */
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

function run(pair: ModelPair, tools: ToolSet = {}) {
  return runRecipeExecution(makeRequest(), { models: pair, tools });
}

describe("runRecipeExecution", () => {
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
      ECHO_TOOL
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
