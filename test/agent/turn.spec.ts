import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import {
  joinSuccessfulBranches,
  renderTurnMessages,
  runTurn,
  type RunTurnArgs
} from "@/agent/turn";
import { createModelPair, type ModelPair } from "@/agent/model";
import { MAX_STEPS, MAX_SUBTASKS } from "@/config";
import {
  deterministicSessionMessage,
  finalReplyMessageId,
  roundAckMessageId,
  sessionText,
  taskUserMessageId
} from "@/agent/history";
import {
  DELEGATE_TOOL_NAME,
  delegateToolCallId,
  type DelegateSubtaskOutcome
} from "@/agent/subtasks/delegate";
import { decompositionProposalSchema } from "@/agent/subtasks/decomposition";
import type {
  CompositionBranch,
  DecompositionProposal
} from "@/agent/subtasks/types";
import { FakeSession } from "../helpers/fake-session";
import { mockModel, type MockStep } from "./mock-model";

const TASK_ID = "task-1";
const CALLER_SUFFIX = "\n\nCalling agent instance: Ada.";

/** Minimal real tool, to exercise the work-tool loop. */
const ECHO_TOOL: ToolSet = {
  echo: tool({
    description: "Echoes its input back.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => text
  })
};

/** A valid proposal as the model would fill the `delegate` call. */
function proposal(
  over: Partial<DecompositionProposal> = {}
): DecompositionProposal {
  return {
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
  };
}

/** The step where the model hands work off — a delegating round's output. */
function delegates(over: Partial<DecompositionProposal> = {}): MockStep {
  return {
    toolCall: { toolName: DELEGATE_TOOL_NAME, input: proposal(over) }
  };
}

function branch(over: Partial<CompositionBranch> = {}): CompositionBranch {
  return {
    subtaskId: 1,
    round: 0,
    ordinal: 0,
    type: "research",
    prompt: "find the thing",
    dependsOn: [],
    status: "completed",
    resultParts: [{ kind: "text", text: "the finding" }],
    error: null,
    ...over
  };
}

/** Drive one round with a scripted primary model. */
function run(
  model: LanguageModel,
  opts: Partial<Omit<RunTurnArgs, "models">> & { session?: FakeSession } = {}
) {
  const session = opts.session ?? new FakeSession();
  return runTurn({
    session,
    taskId: TASK_ID,
    round: opts.round ?? 0,
    text: opts.text ?? "book me a flight",
    allowControl: opts.allowControl ?? true,
    systemSuffix: CALLER_SUFFIX,
    tools: opts.tools ?? {},
    models: createModelPair({ model }),
    branches: opts.branches ?? [],
    onContent: opts.onContent
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

/** A ModelPair whose factories throw — proves a path runs zero inference. */
function neverCalled(): ModelPair & { calls(): number } {
  let calls = 0;
  const boom = () => {
    calls++;
    throw new Error("model must not be called");
  };
  return {
    primary: boom,
    fallback: boom,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model",
    calls: () => calls
  };
}

function runPair(
  models: ModelPair,
  opts: Partial<Omit<RunTurnArgs, "models">> & { session?: FakeSession } = {}
) {
  return runTurn({
    session: opts.session ?? new FakeSession(),
    taskId: TASK_ID,
    round: opts.round ?? 0,
    text: opts.text ?? "book me a flight",
    allowControl: opts.allowControl ?? true,
    systemSuffix: CALLER_SUFFIX,
    tools: opts.tools ?? {},
    models,
    branches: opts.branches ?? []
  });
}

/** Capture the first `doGenerate` options a run sees. */
function capturing(...steps: MockStep[]) {
  const model = mockModel(...steps);
  const orig = model.doGenerate.bind(model);
  const seen: Array<Parameters<typeof orig>[0]> = [];
  model.doGenerate = async (options: Parameters<typeof orig>[0]) => {
    seen.push(options);
    return orig(options);
  };
  return { model, seen };
}

describe("renderTurnMessages — reference catalog", () => {
  it("marks referenceable turns with the index the model selects them by", () => {
    const { messages, catalog } = renderTurnMessages(
      [
        deterministicSessionMessage("a", "user", "first"),
        deterministicSessionMessage("b", "assistant", "second")
      ],
      TASK_ID,
      []
    );
    expect(messages).toEqual([
      { role: "user", content: "[ref 1] first" },
      { role: "assistant", content: "[ref 2] second" }
    ]);
    expect(catalog.map((c) => c.index)).toEqual([1, 2]);
  });

  it("keeps compaction summaries as context but leaves them unmarked", () => {
    const { messages, catalog } = renderTurnMessages(
      [
        deterministicSessionMessage(
          "compaction_1",
          "assistant",
          "summary so far"
        ),
        deterministicSessionMessage("b", "user", "a real turn")
      ],
      TASK_ID,
      []
    );
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
    const { messages, catalog } = renderTurnMessages(
      [
        deterministicSessionMessage("a", "user", "one"),
        deterministicSessionMessage("compaction_1", "assistant", "summary"),
        deterministicSessionMessage("c", "user", "   "),
        deterministicSessionMessage("d", "user", "two")
      ],
      TASK_ID,
      []
    );
    // "two" is catalog index 2 despite being the fourth message.
    expect(messages[3]).toEqual({ role: "user", content: "[ref 2] two" });
    expect(catalog.map((c) => c.text)).toEqual(["one", "two"]);
  });

  it("never lets a marker reach the catalog's snapshot text", () => {
    const { catalog } = renderTurnMessages(
      [deterministicSessionMessage("a", "user", "verbatim text")],
      TASK_ID,
      []
    );
    expect(catalog[0].text).toBe("verbatim text");
  });

  it("does not offer a round's own acknowledgment as a reference", () => {
    // The ack is the agent's scaffolding, not conversation evidence — and it is
    // rendered as a tool call, which a `[ref N]` marker could not live inside.
    const { catalog } = renderTurnMessages(
      [
        deterministicSessionMessage(
          taskUserMessageId(TASK_ID),
          "user",
          "the request"
        ),
        deterministicSessionMessage(
          roundAckMessageId(TASK_ID, 0),
          "assistant",
          "on it"
        )
      ],
      TASK_ID,
      [branch()]
    );
    expect(catalog.map((c) => c.text)).toEqual(["the request"]);
  });

  it("drops this Task's ack when the round has no persisted branches", () => {
    // The crash window: the ack landed, `createDecomposition` did not, and this
    // render belongs to the retry. The leftover must not read as a delegation
    // that happened, and must not be citable.
    const { messages, catalog } = renderTurnMessages(
      [
        deterministicSessionMessage(
          taskUserMessageId(TASK_ID),
          "user",
          "the request"
        ),
        deterministicSessionMessage(
          roundAckMessageId(TASK_ID, 0),
          "assistant",
          "on it"
        )
      ],
      TASK_ID,
      []
    );
    expect(messages).toEqual([
      { role: "user", content: "[ref 1] the request" }
    ]);
    expect(catalog.map((c) => c.text)).toEqual(["the request"]);
  });

  it("keeps another Task's ack as context but never as a reference", () => {
    // Sessions outlive Tasks and are shared across them, so an earlier Task's
    // scaffolding is in this history. It reads as context; it is not evidence.
    const { messages, catalog } = renderTurnMessages(
      [
        deterministicSessionMessage(
          roundAckMessageId("task-earlier", 2),
          "assistant",
          "on it — the earlier task"
        ),
        deterministicSessionMessage(
          taskUserMessageId(TASK_ID),
          "user",
          "the request"
        )
      ],
      TASK_ID,
      []
    );
    expect(messages).toEqual([
      { role: "assistant", content: "on it — the earlier task" },
      { role: "user", content: "[ref 1] the request" }
    ]);
    expect(catalog.map((c) => c.text)).toEqual(["the request"]);
  });
});

describe("renderTurnMessages — reuniting delegate calls with their results", () => {
  const history = [
    deterministicSessionMessage(
      taskUserMessageId(TASK_ID),
      "user",
      "the request"
    ),
    deterministicSessionMessage(
      roundAckMessageId(TASK_ID, 0),
      "assistant",
      "on it"
    )
  ];

  /** The content parts of a rendered message (all but plain-text history). */
  function parts(message: ModelMessage) {
    return Array.isArray(message.content) ? message.content : [];
  }

  function callInput(messages: ModelMessage[], at = 1): DecompositionProposal {
    const call = parts(messages[at]).find((p) => p.type === "tool-call");
    if (!call) throw new Error("no delegate call rendered");
    return call.input as DecompositionProposal;
  }

  function callOutput(
    messages: ModelMessage[],
    at = 2
  ): DelegateSubtaskOutcome[] {
    const result = parts(messages[at]).find((p) => p.type === "tool-result");
    if (!result || result.output.type !== "json") {
      throw new Error("no delegate result rendered");
    }
    return result.output.value as DelegateSubtaskOutcome[];
  }

  it("reunites the delegate call with its result", () => {
    const messages = renderTurnMessages(history, TASK_ID, [branch()]).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    const call = parts(messages[1]).find((p) => p.type === "tool-call");
    const result = parts(messages[2]).find((p) => p.type === "tool-result");
    expect(call?.toolName).toBe(DELEGATE_TOOL_NAME);
    expect(result?.toolName).toBe(DELEGATE_TOOL_NAME);
    // A result the provider cannot pair to its call is a malformed history.
    expect(call?.toolCallId).toBe(delegateToolCallId(TASK_ID, 0));
    expect(result?.toolCallId).toBe(call?.toolCallId);
  });

  it("reconstructs the call in the one shape the tool declares", () => {
    // One schema serves both directions — the calls the model emits and the ones
    // rebuilt from rows. A provider shown two shapes for one tool name is exactly
    // the mismatch this guards against.
    const input = callInput(
      renderTurnMessages(history, TASK_ID, [branch()]).messages
    );
    expect(decompositionProposalSchema.safeParse(input).success).toBe(true);
  });

  it("keeps the acknowledgment the user already saw on the calling turn", () => {
    const messages = renderTurnMessages(history, TASK_ID, [branch()]).messages;
    const text = parts(messages[1]).find((p) => p.type === "text");
    expect(text?.text).toBe("on it");
    expect(callInput(messages).reply).toBe("on it");
  });

  it("carries each outcome under a key derived from the work that produced it", () => {
    const messages = renderTurnMessages(history, TASK_ID, [
      branch({ subtaskId: 7, prompt: "find alpha" }),
      branch({ subtaskId: 9, prompt: "find beta", dependsOn: [7] })
    ]).messages;
    expect(callInput(messages).subtasks).toEqual([
      { localKey: "s7", type: "research", prompt: "find alpha", dependsOn: [] },
      {
        localKey: "s9",
        type: "research",
        prompt: "find beta",
        dependsOn: ["s7"]
      }
    ]);
    expect(callOutput(messages).map((o) => o.subtaskId)).toEqual([7, 9]);
  });

  it("includes each completed branch's text", () => {
    const messages = renderTurnMessages(history, TASK_ID, [
      branch({ subtaskId: 1, resultParts: [{ kind: "text", text: "alpha" }] }),
      branch({ subtaskId: 2, resultParts: [{ kind: "text", text: "beta" }] })
    ]).messages;
    expect(callOutput(messages).map((o) => o.output)).toEqual([
      "alpha",
      "beta"
    ]);
  });

  it("reports failed and skipped branches so they can be disclosed", () => {
    const messages = renderTurnMessages(history, TASK_ID, [
      branch({ subtaskId: 1 }),
      branch({
        subtaskId: 2,
        status: "failed",
        resultParts: null,
        error: "boom"
      }),
      branch({ subtaskId: 3, status: "skipped", resultParts: null })
    ]).messages;
    expect(callOutput(messages)).toEqual([
      {
        subtaskId: 1,
        type: "research",
        status: "completed",
        output: "the finding"
      },
      { subtaskId: 2, type: "research", status: "failed", output: null },
      { subtaskId: 3, type: "research", status: "skipped", output: null }
    ]);
  });

  it("keeps internal diagnostics out of the model's view", () => {
    const messages = renderTurnMessages(history, TASK_ID, [
      branch({
        status: "failed",
        resultParts: null,
        error: "stack trace: connection refused at 10.0.0.1"
      })
    ]).messages;
    expect(JSON.stringify(messages)).not.toContain("connection refused");
  });

  it("still pairs the result when the acknowledgment is gone from history", () => {
    // Compacted away by a concurrent task: the pair must stay well-formed.
    const messages = renderTurnMessages([history[0]], TASK_ID, [
      branch()
    ]).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(parts(messages[1]).some((p) => p.type === "text")).toBe(false);
    expect(callOutput(messages)).toHaveLength(1);
  });

  it("reunites every round's call with its own result, in order", () => {
    const messages = renderTurnMessages(
      [
        history[0],
        history[1],
        deterministicSessionMessage(
          roundAckMessageId(TASK_ID, 1),
          "assistant",
          "digging deeper"
        )
      ],
      TASK_ID,
      [
        branch({ subtaskId: 1, round: 0, ordinal: 0 }),
        branch({
          subtaskId: 2,
          round: 1,
          ordinal: 1,
          resultParts: [{ kind: "text", text: "the deeper finding" }]
        })
      ]
    ).messages;

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool"
    ]);
    // Each round's pair carries its own call id, so neither result can be read
    // as the answer to the other round's call.
    const first = parts(messages[1]).find((p) => p.type === "tool-call");
    const second = parts(messages[3]).find((p) => p.type === "tool-call");
    expect(first?.toolCallId).toBe(delegateToolCallId(TASK_ID, 0));
    expect(second?.toolCallId).toBe(delegateToolCallId(TASK_ID, 1));
    expect(callOutput(messages, 2).map((o) => o.output)).toEqual([
      "the finding"
    ]);
    expect(callOutput(messages, 4).map((o) => o.output)).toEqual([
      "the deeper finding"
    ]);
  });
});

describe("joinSuccessfulBranches", () => {
  it("joins successes in the order given", () => {
    expect(
      joinSuccessfulBranches([
        branch({
          subtaskId: 1,
          resultParts: [{ kind: "text", text: "first" }]
        }),
        branch({
          subtaskId: 2,
          resultParts: [{ kind: "text", text: "second" }]
        })
      ])
    ).toBe("first\n\nsecond");
  });

  it("adds a disclosure note when a branch did not succeed", () => {
    const joined = joinSuccessfulBranches([
      branch({ subtaskId: 1 }),
      branch({ subtaskId: 2, status: "failed", resultParts: null })
    ]);
    expect(joined).toContain("the finding");
    expect(joined).toContain("could not be completed");
  });

  it("adds no note when everything succeeded", () => {
    expect(joinSuccessfulBranches([branch()])).toBe("the finding");
  });
});

describe("runTurn — answering directly", () => {
  it("treats plain text as the final reply", async () => {
    const { outcome } = await run(
      mockModel({ text: "You told me you prefer aisle seats." })
    );
    expect(outcome).toEqual({
      status: "replied",
      reply: "You told me you prefer aisle seats."
    });
  });

  it("persists the answer under the final-reply id, with no ack", async () => {
    const { session } = await run(mockModel({ text: "the answer" }));
    expect(session.messages.map((m) => m.id)).toEqual([
      taskUserMessageId(TASK_ID),
      finalReplyMessageId(TASK_ID)
    ]);
  });

  it("lets the round use its work tools and then answer", async () => {
    // The point of the change: a request the main agent can settle itself needs
    // no subagent, but may well need a lookup first.
    const { outcome } = await run(
      mockModel(
        { toolCall: { toolName: "echo", input: { text: "ping" } } },
        { text: "answered after looking" }
      ),
      { tools: ECHO_TOOL }
    );
    expect(outcome).toEqual({
      status: "replied",
      reply: "answered after looking"
    });
  });

  it("answers from branch results without delegating again", async () => {
    const { outcome, session } = await run(
      mockModel({ text: "Here is what I found." }),
      { round: 1, branches: [branch()] }
    );
    expect(outcome).toEqual({
      status: "replied",
      reply: "Here is what I found."
    });
    // Round 1 must not re-append the user turn.
    expect(session.messages.map((m) => m.id)).toEqual([
      finalReplyMessageId(TASK_ID)
    ]);
  });
});

describe("runTurn — delegating", () => {
  it("returns the acknowledgment and the resolved drafts", async () => {
    const { outcome } = await run(mockModel(delegates()));
    expect(outcome.status).toBe("delegated");
    if (outcome.status !== "delegated") return;
    expect(outcome.reply).toBe("On it — I'll look into that.");
    expect(outcome.drafts).toHaveLength(1);
    expect(outcome.drafts[0].localKey).toBe("research");
  });

  it("snapshots the selected turn verbatim onto the draft", async () => {
    const { outcome } = await run(mockModel(delegates()));
    if (outcome.status !== "delegated") throw new Error("expected delegated");
    // Index 1 is the inbound user turn this round just appended.
    expect(outcome.drafts[0].references).toEqual([
      { role: "user", text: "book me a flight" }
    ]);
  });

  it("appends the user turn and the ack under deterministic ids", async () => {
    const { session } = await run(mockModel(delegates()));
    expect(session.messages.map((m) => m.id)).toEqual([
      taskUserMessageId(TASK_ID),
      roundAckMessageId(TASK_ID, 0)
    ]);
    expect(sessionText(session.messages[0])).toBe("book me a flight");
    expect(sessionText(session.messages[1])).toBe(
      "On it — I'll look into that."
    );
  });

  it("keys a later round's ack to that round", async () => {
    const { session } = await run(
      // A later round's catalog is built from its own history, so this
      // delegation cites nothing.
      mockModel(
        delegates({
          subtasks: [{ localKey: "a", type: "t", prompt: "p", dependsOn: [] }]
        })
      ),
      { round: 2, branches: [branch()] }
    );
    expect(session.messages.map((m) => m.id)).toEqual([
      roundAckMessageId(TASK_ID, 2)
    ]);
  });

  it("accepts a delegation that references nothing", async () => {
    const { outcome } = await run(
      mockModel(
        delegates({
          subtasks: [{ localKey: "a", type: "t", prompt: "p", dependsOn: [] }]
        })
      )
    );
    expect(outcome.status).toBe("delegated");
    if (outcome.status !== "delegated") return;
    expect(outcome.drafts[0].references).toEqual([]);
  });

  it("gives the model the soul, caller context, and the round contract", async () => {
    const { model, seen } = capturing(delegates());
    await run(model);
    const prompt = JSON.stringify(seen[0]?.prompt);
    expect(prompt).toContain("SOUL BLOCK");
    expect(prompt).toContain("Calling agent instance: Ada");
    expect(prompt).toContain("Answering this request");
    expect(prompt).toContain("[ref 1] book me a flight");
  });

  /**
   * The delegation wiring: `delegate` must reach the provider carrying the
   * delegation contract as its input schema, **alongside** the work tools — that
   * pairing is what lets the model look something up and then hand the work off
   * within one round.
   *
   * Boundary: this proves the AI SDK passes the tool and its schema through, so
   * `workers-ai-provider` will see a function tool to map onto Workers-AI's
   * `tools`. It cannot prove the real models *honor* the schema —
   * `MockLanguageModelV3` returns scripted calls regardless, and `env.AI` has no
   * local mode. That remains unverified until a live run.
   */
  it("sends the delegation contract as the delegate tool's schema, alongside work tools", async () => {
    const { model, seen } = capturing(delegates());
    await run(model, { tools: ECHO_TOOL });

    const delegate = seen[0]?.tools?.find((t) => t.name === DELEGATE_TOOL_NAME);
    if (delegate?.type !== "function") {
      throw new Error("expected a delegate function tool");
    }
    const schema = delegate.inputSchema;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "reply",
      "subtasks"
    ]);
    // The 1..8 per-round bound the model is held to, mirroring MAX_SUBTASKS.
    expect(schema?.properties?.subtasks).toMatchObject({
      minItems: 1,
      maxItems: MAX_SUBTASKS
    });
    // ...and the work tools ride on the same call.
    expect(seen[0]?.tools?.map((t) => t.name)).toContain("echo");
  });

  it("fails the attempt when the step budget runs out mid-tool-use", async () => {
    // A model that only ever reasons never lands on a decision. Nothing forces
    // it any more, so the bound has to come from `MAX_STEPS` — and an undecided
    // round is an attempt failure, not a hang and not an empty reply.
    const looping: MockStep[] = Array.from({ length: MAX_STEPS + 2 }, () => ({
      toolCall: { toolName: "echo", input: { text: "ping" } }
    }));
    const { model, seen } = capturing(...looping);
    const outcome = await runPair(
      modelPair(
        () => model,
        () => mockModel({ text: "the fallback answered" })
      ),
      { tools: ECHO_TOOL }
    );

    expect(seen).toHaveLength(MAX_STEPS);
    expect(outcome).toEqual({
      status: "replied",
      reply: "the fallback answered"
    });
  });

  it("never forces the choice", async () => {
    // The whole point: no `toolChoice` pinning in either direction. A round that
    // wants to answer may, and a round that wants to delegate may.
    const { model, seen } = capturing(
      { toolCall: { toolName: "echo", input: { text: "ping" } } },
      delegates()
    );
    await run(model, { tools: ECHO_TOOL });
    expect(seen.map((o) => o.toolChoice)).toEqual([
      { type: "auto" },
      { type: "auto" }
    ]);
  });

  it("streams intermediate content while reasoning", async () => {
    const streamed: Array<{ text: string; index: number }> = [];
    await run(
      mockModel(
        {
          text: "checking something",
          toolCall: { toolName: "echo", input: { text: "ping" } }
        },
        delegates()
      ),
      {
        tools: ECHO_TOOL,
        onContent: (text, index) => {
          streamed.push({ text, index });
        }
      }
    );
    expect(streamed).toEqual([{ text: "checking something", index: 0 }]);
  });
});

describe("runTurn — the final round", () => {
  it("does not declare the delegate tool at all", async () => {
    const { model, seen } = capturing({ text: "the answer" });
    await run(model, { allowControl: false, tools: ECHO_TOOL });
    const names = seen[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("echo");
    expect(names).not.toContain(DELEGATE_TOOL_NAME);
  });

  it("tells the model it must answer now", async () => {
    const { model, seen } = capturing({ text: "the answer" });
    await run(model, { allowControl: false });
    expect(JSON.stringify(seen[0]?.prompt)).toContain("No further delegation");
  });

  it("still gives the model its work tools", async () => {
    const { outcome } = await run(
      mockModel(
        { toolCall: { toolName: "echo", input: { text: "ping" } } },
        { text: "looked it up, then answered" }
      ),
      { allowControl: false, tools: ECHO_TOOL }
    );
    expect(outcome).toEqual({
      status: "replied",
      reply: "looked it up, then answered"
    });
  });
});

describe("runTurn — invalid model output", () => {
  it("falls back when the first model's call violates the schema", async () => {
    const outcome = await runPair(
      modelPair(
        () =>
          mockModel({
            // A blank reply and no subtasks: rejected at the schema edge.
            toolCall: {
              toolName: DELEGATE_TOOL_NAME,
              input: { reply: "", subtasks: [] }
            }
          }),
        () => mockModel(delegates())
      )
    );
    expect(outcome.status).toBe("delegated");
  });

  it("falls back when the first model's graph is invalid", async () => {
    const cyclic = delegates({
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
        () => mockModel(cyclic),
        () => mockModel(delegates())
      )
    );
    expect(outcome.status).toBe("delegated");
  });

  it("rejects a reference index the catalog does not have", async () => {
    const unknownRef = delegates({
      subtasks: [
        {
          localKey: "a",
          type: "t",
          prompt: "p",
          referenceIndexes: [99],
          dependsOn: []
        }
      ]
    });
    const outcome = await runPair(
      modelPair(
        () => mockModel(unknownRef),
        () => mockModel(unknownRef)
      )
    );
    expect(outcome.status).toBe("failed");
  });

  it("fails the task when both models produce no decision", async () => {
    const outcome = await runPair(
      modelPair(
        () => mockModel({ text: "   " }),
        () => mockModel({ text: "" })
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
        () => mockModel({ text: "" }),
        () => mockModel({ text: "" })
      )
    );
    expect(outcome).not.toHaveProperty("drafts");
  });

  it("does not append a reply when the round fails", async () => {
    const session = new FakeSession();
    await runPair(
      modelPair(
        () => mockModel({ text: "" }),
        () => mockModel({ text: "" })
      ),
      { session }
    );
    // The user turn is appended (it is the caller's message, and true regardless);
    // no assistant reply is.
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("runTurn — resilience", () => {
  it("falls back to the second model when the first throws", async () => {
    const outcome = await runPair(
      modelPair(
        () => {
          throw new Error("primary boom");
        },
        () => mockModel(delegates())
      )
    );
    expect(outcome.status).toBe("delegated");
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

describe("runTurn — degrading to the durable work", () => {
  const two = [
    branch({ subtaskId: 1, resultParts: [{ kind: "text", text: "alpha" }] }),
    branch({ subtaskId: 2, resultParts: [{ kind: "text", text: "beta" }] })
  ];

  const broken = () =>
    modelPair(
      () => {
        throw new Error("kaboom");
      },
      () => {
        throw new Error("kaboom");
      }
    );

  it("joins the branch results when both models fail deterministically", async () => {
    const outcome = await runPair(broken(), { round: 1, branches: two });
    // The work is done and durable — deliver it rather than failing the task.
    expect(outcome).toEqual({ status: "replied", reply: "alpha\n\nbeta" });
  });

  it("notes the gap when the deterministic join covers a failure", async () => {
    const outcome = await runPair(broken(), {
      round: 1,
      branches: [
        two[0],
        branch({ subtaskId: 2, status: "failed", resultParts: null })
      ]
    });
    if (outcome.status !== "replied") throw new Error("expected replied");
    expect(outcome.reply).toContain("alpha");
    expect(outcome.reply).toContain("could not be completed");
  });

  it("fails rather than joining when nothing succeeded", async () => {
    const outcome = await runPair(broken(), {
      round: 1,
      branches: [
        branch({ subtaskId: 1, status: "failed", resultParts: null }),
        branch({ subtaskId: 2, status: "skipped", resultParts: null })
      ]
    });
    expect(outcome.status).toBe("failed");
  });

  it("lets the model answer honestly when every branch failed", async () => {
    // Not a bypass and not an automatic Task failure: the model sees the failed
    // outcomes and says what it could not do.
    const outcome = await runPair(
      modelPair(
        () => mockModel({ text: "I could not reach that service." }),
        () => mockModel({ text: "unused" })
      ),
      {
        round: 1,
        branches: [branch({ status: "failed", resultParts: null })]
      }
    );
    expect(outcome).toEqual({
      status: "replied",
      reply: "I could not reach that service."
    });
  });

  it("composes a single successful branch rather than shipping it raw", async () => {
    // The old single-node bypass returned the subtask's text verbatim; a research
    // result is material, not an answer.
    const models = createModelPair({
      model: mockModel({ text: "In short: the finding, explained." })
    });
    const outcome = await runTurn({
      session: new FakeSession(),
      taskId: TASK_ID,
      round: 1,
      text: "unused",
      allowControl: true,
      systemSuffix: CALLER_SUFFIX,
      tools: {},
      models,
      branches: [branch()]
    });
    expect(outcome).toEqual({
      status: "replied",
      reply: "In short: the finding, explained."
    });
  });
});

describe("runTurn — storage faults are not model faults", () => {
  it("propagates a session write failure instead of blaming the model", async () => {
    const session = new FakeSession();
    session.appendMessage = () => {
      throw new Error("sqlite write failed");
    };
    let attempts = 0;
    const counting = () => {
      attempts++;
      return mockModel(delegates());
    };

    // A storage fault must reach the workflow step (which retries), not be
    // reported as "both models produced unusable output".
    await expect(
      runPair(modelPair(counting, counting), { session })
    ).rejects.toThrow(/sqlite write failed/);
    expect(attempts).toBe(0);
  });

  it("does not burn a fallback inference when the ack append fails", async () => {
    const session = new FakeSession();
    let appends = 0;
    const realAppend = session.appendMessage.bind(session);
    session.appendMessage = (m) => {
      // The user turn lands; the ack append (the second) fails.
      if (++appends === 2) throw new Error("sqlite write failed");
      realAppend(m);
    };
    let attempts = 0;
    const counting = () => {
      attempts++;
      return mockModel(delegates());
    };

    await expect(
      runPair(modelPair(counting, counting), { session })
    ).rejects.toThrow(/sqlite write failed/);
    // Exactly one: the fallback model must not re-run for a storage fault.
    expect(attempts).toBe(1);
  });
});

describe("runTurn — replay safety", () => {
  it("does not duplicate the user turn on a re-run", async () => {
    const session = new FakeSession();
    await run(mockModel(delegates()), { session });
    await run(mockModel(delegates()), { session });
    expect(
      session.messages.filter((m) => m.id === taskUserMessageId(TASK_ID))
    ).toHaveLength(1);
  });

  it("keeps the first attempt's ack when a re-run infers a different one", async () => {
    const session = new FakeSession();
    await run(mockModel(delegates()), { session });

    const second = await run(
      mockModel(delegates({ reply: "A completely different reply." })),
      { session }
    );

    // The durable ack wins: it may already be in front of the user.
    expect(second.outcome.status).toBe("delegated");
    if (second.outcome.status !== "delegated") return;
    expect(second.outcome.reply).toBe("On it — I'll look into that.");
    expect(sessionText(session.messages[1])).toBe(
      "On it — I'll look into that."
    );
  });

  it("keeps the first attempt's answer when a re-run infers a different one", async () => {
    const session = new FakeSession();
    await run(mockModel({ text: "first answer" }), { session });
    const second = await run(mockModel({ text: "second answer" }), { session });
    expect(second.outcome).toEqual({
      status: "replied",
      reply: "first answer"
    });
  });

  it("proves the never-called pair really would fail a run", async () => {
    // Guards the `neverCalled` helper the RPC-level recovery specs rely on.
    const models = neverCalled();
    const outcome = await runPair(models);
    expect(outcome.status).toBe("failed");
    expect(models.calls()).toBe(2);
  });
});
