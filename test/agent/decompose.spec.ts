import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { runDecompose, renderDecompositionMessages } from "@/agent/decompose";
import { createModelPair, type ModelPair } from "@/agent/model";
import {
  decomposeReplyMessageId,
  deterministicSessionMessage,
  sessionText,
  taskUserMessageId
} from "@/agent/history";
import type { DecompositionProposal } from "@/agent/subtasks/types";
import { FakeSession } from "../helpers/fake-session";
import { mockModel } from "./mock-model";

const TASK_ID = "task-1";
const CALLER_SUFFIX = "\n\nCalling agent instance: Ada.";

/** Minimal real tool, to exercise the reasoning tool loop. */
const ECHO_TOOL: ToolSet = {
  echo: tool({
    description: "Echoes its input back.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => text
  })
};

/** A valid proposal as the model would emit it. */
function proposal(over: Partial<DecompositionProposal> = {}): string {
  return JSON.stringify({
    reply: "On it — I'll look into that.",
    subtasks: [
      {
        localKey: "research",
        type: "research",
        prompt: "Research the thing",
        referenceIndexes: [1],
        dependsOn: []
      }
    ],
    ...over
  });
}

/** Drive a decomposition with a scripted primary model. */
function run(
  model: LanguageModel,
  opts: { session?: FakeSession; tools?: ToolSet; text?: string } = {}
) {
  const session = opts.session ?? new FakeSession();
  return runDecompose({
    session,
    taskId: TASK_ID,
    text: opts.text ?? "book me a flight",
    systemSuffix: CALLER_SUFFIX,
    tools: opts.tools ?? {},
    models: createModelPair({ model })
  }).then((outcome) => ({ outcome, session }));
}

/**
 * Build a `ModelPair` from raw factories. Error-path tests throw *from the
 * factory* rather than from a rejecting `doGenerate`, which would leak an
 * unhandled rejection through the AI SDK telemetry span that workerd flags.
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

function runPair(models: ModelPair, session = new FakeSession()) {
  return runDecompose({
    session,
    taskId: TASK_ID,
    text: "book me a flight",
    systemSuffix: CALLER_SUFFIX,
    tools: {},
    models
  });
}

describe("renderDecompositionMessages", () => {
  it("marks referenceable turns with the index the model selects them by", () => {
    const { messages, catalog } = renderDecompositionMessages([
      deterministicSessionMessage("a", "user", "first"),
      deterministicSessionMessage("b", "assistant", "second")
    ]);
    expect(messages).toEqual([
      { role: "user", content: "[ref 1] first" },
      { role: "assistant", content: "[ref 2] second" }
    ]);
    expect(catalog.map((c) => c.index)).toEqual([1, 2]);
  });

  it("keeps compaction summaries as context but leaves them unmarked", () => {
    const { messages, catalog } = renderDecompositionMessages([
      deterministicSessionMessage(
        "compaction_1",
        "assistant",
        "summary so far"
      ),
      deterministicSessionMessage("b", "user", "a real turn")
    ]);
    // The summary is readable context; it is not citable as conversation evidence.
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "summary so far"
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: "[ref 1] a real turn"
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0].text).toBe("a real turn");
  });

  it("keeps markers aligned with the catalog when a turn is skipped", () => {
    const { messages, catalog } = renderDecompositionMessages([
      deterministicSessionMessage("a", "user", "one"),
      deterministicSessionMessage("compaction_1", "assistant", "summary"),
      deterministicSessionMessage("c", "user", "   "),
      deterministicSessionMessage("d", "user", "two")
    ]);
    // "two" is catalog index 2 despite being the fourth message.
    expect(messages[3]).toEqual({ role: "user", content: "[ref 2] two" });
    expect(catalog.map((c) => c.text)).toEqual(["one", "two"]);
  });

  it("never lets a marker reach the catalog's snapshot text", () => {
    const { catalog } = renderDecompositionMessages([
      deterministicSessionMessage("a", "user", "verbatim text")
    ]);
    expect(catalog[0].text).toBe("verbatim text");
  });
});

describe("runDecompose — happy path", () => {
  it("returns the reply and the resolved drafts", async () => {
    const { outcome } = await run(mockModel({ text: proposal() }));
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.reply).toBe("On it — I'll look into that.");
    expect(outcome.drafts).toHaveLength(1);
    expect(outcome.drafts[0].localKey).toBe("research");
  });

  it("snapshots the selected turn verbatim onto the draft", async () => {
    const { outcome } = await run(mockModel({ text: proposal() }));
    if (outcome.status !== "completed") throw new Error("expected completed");
    // Index 1 is the inbound user turn this decomposition just appended.
    expect(outcome.drafts[0].references).toEqual([
      { role: "user", text: "book me a flight" }
    ]);
  });

  it("appends the user turn and the reply under deterministic ids", async () => {
    const { session } = await run(mockModel({ text: proposal() }));
    expect(session.messages.map((m) => m.id)).toEqual([
      taskUserMessageId(TASK_ID),
      decomposeReplyMessageId(TASK_ID)
    ]);
    expect(sessionText(session.messages[0])).toBe("book me a flight");
    expect(sessionText(session.messages[1])).toBe(
      "On it — I'll look into that."
    );
  });

  it("gives the model the soul, caller context, and decomposition contract", async () => {
    let seen = "";
    const capturing = mockModel({ text: proposal() });
    const orig = capturing.doGenerate.bind(capturing);
    capturing.doGenerate = async (options: Parameters<typeof orig>[0]) => {
      seen = JSON.stringify(options.prompt);
      return orig(options);
    };
    await run(capturing);
    expect(seen).toContain("SOUL BLOCK");
    expect(seen).toContain("Calling agent instance: Ada");
    expect(seen).toContain("Task decomposition");
    expect(seen).toContain("[ref 1] book me a flight");
  });

  it("streams intermediate content while reasoning", async () => {
    const streamed: Array<{ text: string; index: number }> = [];
    await runDecompose({
      session: new FakeSession(),
      taskId: TASK_ID,
      text: "book me a flight",
      systemSuffix: CALLER_SUFFIX,
      tools: ECHO_TOOL,
      models: createModelPair({
        model: mockModel(
          {
            text: "checking something",
            toolCall: { toolName: "echo", input: { text: "ping" } }
          },
          { text: proposal() }
        )
      }),
      onContent: (text, index) => {
        streamed.push({ text, index });
      }
    });
    expect(streamed).toEqual([{ text: "checking something", index: 0 }]);
  });
});

describe("runDecompose — invalid model output", () => {
  it("falls back to the second model when the first emits unparseable output", async () => {
    const outcome = await runPair(
      modelPair(
        () => mockModel({ text: "not json at all" }),
        () => mockModel({ text: proposal() })
      )
    );
    expect(outcome.status).toBe("completed");
  });

  it("falls back when the first model's graph is invalid", async () => {
    const cyclic = JSON.stringify({
      reply: "On it.",
      subtasks: [
        {
          localKey: "a",
          type: "t",
          prompt: "p",
          referenceIndexes: [],
          dependsOn: ["b"]
        },
        {
          localKey: "b",
          type: "t",
          prompt: "p",
          referenceIndexes: [],
          dependsOn: ["a"]
        }
      ]
    });
    const outcome = await runPair(
      modelPair(
        () => mockModel({ text: cyclic }),
        () => mockModel({ text: proposal() })
      )
    );
    expect(outcome.status).toBe("completed");
  });

  it("fails the task when both models emit unusable output", async () => {
    const outcome = await runPair(
      modelPair(
        () => mockModel({ text: "garbage" }),
        () => mockModel({ text: "also garbage" })
      )
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error).toContain("exhausted both models");
    expect(outcome.error).toContain("primary-model");
    expect(outcome.error).toContain("fallback-model");
  });

  it("never synthesizes a subtask from unusable output", async () => {
    const outcome = await runPair(
      modelPair(
        () => mockModel({ text: "garbage" }),
        () => mockModel({ text: "garbage" })
      )
    );
    expect(outcome).not.toHaveProperty("drafts");
  });

  it("does not append a reply when decomposition fails", async () => {
    const session = new FakeSession();
    await runPair(
      modelPair(
        () => mockModel({ text: "garbage" }),
        () => mockModel({ text: "garbage" })
      ),
      session
    );
    // The user turn is appended (it is the caller's message, and true regardless);
    // no assistant reply is.
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("rejects a reference index the catalog does not have", async () => {
    const outcome = await runPair(
      modelPair(
        () =>
          mockModel({
            text: proposal({
              subtasks: [
                {
                  localKey: "a",
                  type: "t",
                  prompt: "p",
                  referenceIndexes: [99],
                  dependsOn: []
                }
              ]
            })
          }),
        () =>
          mockModel({
            text: proposal({
              subtasks: [
                {
                  localKey: "a",
                  type: "t",
                  prompt: "p",
                  referenceIndexes: [99],
                  dependsOn: []
                }
              ]
            })
          })
      )
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("runDecompose — resilience", () => {
  it("falls back to the second model when the first throws", async () => {
    const outcome = await runPair(
      modelPair(
        () => {
          throw new Error("primary boom");
        },
        () => mockModel({ text: proposal() })
      )
    );
    expect(outcome.status).toBe("completed");
  });

  it("throws a transient fault so the workflow step retries", async () => {
    await expect(
      runPair(
        modelPair(
          () => {
            throw new Error("3040: capacity temporarily exceeded");
          },
          () => {
            throw new Error("3040: capacity temporarily exceeded");
          }
        )
      )
    ).rejects.toThrow(/capacity temporarily exceeded/);
  });

  it("fails (does not throw) when both models fail deterministically", async () => {
    const outcome = await runPair(
      modelPair(
        () => {
          throw new Error("kaboom");
        },
        () => {
          throw new Error("kaboom");
        }
      )
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("runDecompose — storage faults are not model faults", () => {
  it("propagates a session write failure instead of blaming the model", async () => {
    const session = new FakeSession();
    session.appendMessage = () => {
      throw new Error("sqlite write failed");
    };
    let attempts = 0;
    const counting = () => {
      attempts++;
      return mockModel({ text: proposal() });
    };

    // A storage fault must reach the workflow step (which retries), not be
    // reported as "both models produced unusable output".
    await expect(
      runPair(modelPair(counting, counting), session)
    ).rejects.toThrow(/sqlite write failed/);
    expect(attempts).toBe(0);
  });

  it("does not burn a fallback inference when the reply append fails", async () => {
    const session = new FakeSession();
    let appends = 0;
    const realAppend = session.appendMessage.bind(session);
    session.appendMessage = (m) => {
      // The user turn lands; the reply append (the second) fails.
      if (++appends === 2) throw new Error("sqlite write failed");
      realAppend(m);
    };
    let attempts = 0;
    const counting = () => {
      attempts++;
      return mockModel({ text: proposal() });
    };

    await expect(
      runPair(modelPair(counting, counting), session)
    ).rejects.toThrow(/sqlite write failed/);
    // Exactly one: the fallback model must not re-run for a storage fault.
    expect(attempts).toBe(1);
  });
});

describe("runDecompose — replay safety", () => {
  it("does not duplicate the user turn on a re-run", async () => {
    const session = new FakeSession();
    await run(mockModel({ text: proposal() }), { session });
    await run(mockModel({ text: proposal() }), { session });
    expect(
      session.messages.filter((m) => m.id === taskUserMessageId(TASK_ID))
    ).toHaveLength(1);
  });

  it("keeps the first attempt's reply when a re-run infers a different one", async () => {
    const session = new FakeSession();
    await run(mockModel({ text: proposal() }), { session });

    const second = await run(
      mockModel({ text: proposal({ reply: "A completely different reply." }) }),
      { session }
    );

    // The durable reply wins: it may already be in front of the user.
    expect(second.outcome.status).toBe("completed");
    if (second.outcome.status !== "completed") return;
    expect(second.outcome.reply).toBe("On it — I'll look into that.");
    expect(sessionText(session.messages[1])).toBe(
      "On it — I'll look into that."
    );
  });
});
