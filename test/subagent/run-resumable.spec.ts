/**
 * The generic resumable runner (src/subagent/run.ts `runResumableChunk`): the one
 * loop every recipe runs. Covers single-chunk completion, multi-chunk yield +
 * resume, turn-budget exhaustion → summary, and a progress event ending a chunk.
 */
import { describe, it, expect } from "vitest";
import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import {
  runResumableChunk,
  type ChunkRunDeps,
  type ChunkRunState
} from "@/subagent/run";
import type { ModelPair } from "@/agent/model";
import type { ProgressEvent, RecipeLimits } from "@/agent/subtasks/types";
import { mockModel, type MockStep } from "../agent/mock-model";

/** A ModelPair whose both slots return the same scripted model instance. */
function pairOf(model: LanguageModel): ModelPair {
  return {
    primary: () => model,
    fallback: () => model,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model"
  };
}

const ECHO: ToolSet = {
  echo: tool({
    description: "echo",
    inputSchema: z.object({}),
    execute: async () => "ok"
  })
};

const CALL_ECHO: MockStep = { toolCall: { toolName: "echo", input: {} } };

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

describe("runResumableChunk", () => {
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
