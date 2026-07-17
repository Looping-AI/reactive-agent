import { describe, it, expect } from "vitest";
import type { LanguageModel, ModelMessage } from "ai";
import {
  joinSuccessfulBranches,
  renderCompositionMessages,
  runCompose
} from "@/agent/compose";
import { createModelPair, type ModelPair } from "@/agent/model";
import {
  decomposeReplyMessageId,
  deterministicSessionMessage,
  finalReplyMessageId,
  sessionText,
  taskUserMessageId
} from "@/agent/history";
import {
  DELEGATE_TOOL_NAME,
  delegatedCallSchema,
  delegateToolCallId,
  type DelegateCallInput,
  type DelegateSubtaskOutcome
} from "@/agent/subtasks/delegate";
import { decompositionProposalSchema } from "@/agent/subtasks/decomposition";
import type { CompositionBranch } from "@/agent/subtasks/types";
import { FakeSession } from "../helpers/fake-session";
import { mockModel } from "./mock-model";

const TASK_ID = "task-1";
const CALLER_SUFFIX = "\n\nCalling agent instance: Ada.";

function branch(over: Partial<CompositionBranch> = {}): CompositionBranch {
  return {
    subtaskId: 1,
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

function run(
  branches: CompositionBranch[],
  models: ModelPair,
  session = new FakeSession()
) {
  return runCompose({
    session,
    taskId: TASK_ID,
    systemSuffix: CALLER_SUFFIX,
    models,
    branches
  }).then((result) => ({ result, session }));
}

describe("renderCompositionMessages", () => {
  const history = [
    deterministicSessionMessage(
      taskUserMessageId(TASK_ID),
      "user",
      "the request"
    ),
    deterministicSessionMessage(
      decomposeReplyMessageId(TASK_ID),
      "assistant",
      "on it"
    )
  ];

  /** The content parts of a rendered message (all but plain-text history). */
  function parts(message: ModelMessage) {
    return Array.isArray(message.content) ? message.content : [];
  }

  function callInput(messages: ModelMessage[]): DelegateCallInput {
    const call = parts(messages[1]).find((p) => p.type === "tool-call");
    if (!call) throw new Error("no delegate call rendered");
    return call.input as DelegateCallInput;
  }

  function callOutput(messages: ModelMessage[]): DelegateSubtaskOutcome[] {
    const result = parts(messages[2]).find((p) => p.type === "tool-result");
    if (!result || result.output.type !== "json") {
      throw new Error("no delegate result rendered");
    }
    return result.output.value as DelegateSubtaskOutcome[];
  }

  it("reunites the delegate call with its result", () => {
    const messages = renderCompositionMessages(history, TASK_ID, [branch()]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    const call = parts(messages[1]).find((p) => p.type === "tool-call");
    const result = parts(messages[2]).find((p) => p.type === "tool-result");
    expect(call?.toolName).toBe(DELEGATE_TOOL_NAME);
    expect(result?.toolName).toBe(DELEGATE_TOOL_NAME);
    // A result the provider cannot pair to its call is a malformed history.
    expect(call?.toolCallId).toBe(delegateToolCallId(TASK_ID));
    expect(result?.toolCallId).toBe(call?.toolCallId);
  });

  it("reconstructs the call in the shape the compose tool declares", () => {
    // The compose model is shown `composeDelegateTool` (delegatedCallSchema); the
    // reunited call must match it, and must NOT be the emitted Phase 1 shape —
    // declaring the wrong face is exactly the mismatch this guards against.
    const input = callInput(
      renderCompositionMessages(history, TASK_ID, [branch()])
    );
    expect(delegatedCallSchema.safeParse(input).success).toBe(true);
    expect(decompositionProposalSchema.safeParse(input).success).toBe(false);
  });

  it("keeps the acknowledgment the user already saw on the calling turn", () => {
    const messages = renderCompositionMessages(history, TASK_ID, [branch()]);
    const text = parts(messages[1]).find((p) => p.type === "text");
    expect(text?.text).toBe("on it");
    expect(callInput(messages).reply).toBe("on it");
  });

  it("carries each outcome under the id of the work that produced it", () => {
    const messages = renderCompositionMessages(history, TASK_ID, [
      branch({ subtaskId: 7, prompt: "find alpha" }),
      branch({ subtaskId: 9, prompt: "find beta", dependsOn: [7] })
    ]);
    expect(callInput(messages).subtasks).toEqual([
      { id: 7, type: "research", prompt: "find alpha", dependsOn: [] },
      { id: 9, type: "research", prompt: "find beta", dependsOn: [7] }
    ]);
    expect(callOutput(messages).map((o) => o.subtaskId)).toEqual([7, 9]);
  });

  it("includes each completed branch's text", () => {
    const messages = renderCompositionMessages(history, TASK_ID, [
      branch({ subtaskId: 1, resultParts: [{ kind: "text", text: "alpha" }] }),
      branch({ subtaskId: 2, resultParts: [{ kind: "text", text: "beta" }] })
    ]);
    expect(callOutput(messages).map((o) => o.output)).toEqual([
      "alpha",
      "beta"
    ]);
  });

  it("reports failed and skipped branches so they can be disclosed", () => {
    const messages = renderCompositionMessages(history, TASK_ID, [
      branch({ subtaskId: 1 }),
      branch({
        subtaskId: 2,
        status: "failed",
        resultParts: null,
        error: "boom"
      }),
      branch({ subtaskId: 3, status: "skipped", resultParts: null })
    ]);
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
    const messages = renderCompositionMessages(history, TASK_ID, [
      branch({
        status: "failed",
        resultParts: null,
        error: "stack trace: connection refused at 10.0.0.1"
      })
    ]);
    expect(JSON.stringify(messages)).not.toContain("connection refused");
  });

  it("still pairs the result when the acknowledgment is gone from history", () => {
    // Compacted away by a concurrent task: the pair must stay well-formed.
    const messages = renderCompositionMessages([history[0]], TASK_ID, [
      branch()
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(parts(messages[1]).some((p) => p.type === "text")).toBe(false);
    expect(callOutput(messages)).toHaveLength(1);
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

describe("runCompose — bypass and failure without inference", () => {
  it("returns the single subtask's result directly, with no inference", async () => {
    const models = neverCalled();
    const { result } = await run([branch()], models);
    expect(result).toEqual({ status: "completed", reply: "the finding" });
    expect(models.calls()).toBe(0);
  });

  it("persists the bypassed reply to the session", async () => {
    const { session } = await run([branch()], neverCalled());
    expect(session.messages.map((m) => m.id)).toEqual([
      finalReplyMessageId(TASK_ID)
    ]);
    expect(sessionText(session.messages[0])).toBe("the finding");
  });

  it("joins a single subtask's multiple parts", async () => {
    const { result } = await run(
      [
        branch({
          resultParts: [
            { kind: "text", text: "part one" },
            { kind: "text", text: "part two" }
          ]
        })
      ],
      neverCalled()
    );
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.reply).toBe("part one\npart two");
  });

  it("fails without inference when no branch succeeded", async () => {
    const models = neverCalled();
    const { result } = await run(
      [
        branch({ subtaskId: 1, status: "failed", resultParts: null }),
        branch({ subtaskId: 2, status: "skipped", resultParts: null })
      ],
      models
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toContain("no subtask succeeded");
    expect(models.calls()).toBe(0);
  });

  it("composes (does not bypass) a multi-branch task with one success", async () => {
    // The bypass is single-node only: with siblings, the failure must be disclosed.
    const { result } = await run(
      [
        branch({ subtaskId: 1 }),
        branch({ subtaskId: 2, status: "failed", resultParts: null })
      ],
      createModelPair({ model: mockModel({ text: "composed reply" }) })
    );
    expect(result).toEqual({ status: "completed", reply: "composed reply" });
  });
});

describe("runCompose — multi-branch composition", () => {
  const two = [
    branch({ subtaskId: 1, resultParts: [{ kind: "text", text: "alpha" }] }),
    branch({ subtaskId: 2, resultParts: [{ kind: "text", text: "beta" }] })
  ];

  it("returns the composed reply and appends it under the final id", async () => {
    const { result, session } = await run(
      two,
      createModelPair({ model: mockModel({ text: "the answer" }) })
    );
    expect(result).toEqual({ status: "completed", reply: "the answer" });
    expect(session.messages.map((m) => m.id)).toEqual([
      finalReplyMessageId(TASK_ID)
    ]);
  });

  it("gives the model the branch outcomes and the composition contract", async () => {
    let seen = "";
    const capturing = mockModel({ text: "the answer" });
    const orig = capturing.doGenerate.bind(capturing);
    capturing.doGenerate = async (options: Parameters<typeof orig>[0]) => {
      seen = JSON.stringify(options.prompt);
      return orig(options);
    };
    await run(two, createModelPair({ model: capturing }));
    expect(seen).toContain("SOUL BLOCK");
    expect(seen).toContain("Composing the final answer");
    expect(seen).toContain("alpha");
    expect(seen).toContain("beta");
  });

  it("declares delegate in its resolved shape and forbids re-calling it", async () => {
    const capturing = mockModel({ text: "the answer" });
    const orig = capturing.doGenerate.bind(capturing);
    let seen: Parameters<typeof orig>[0] | undefined;
    capturing.doGenerate = async (options: Parameters<typeof orig>[0]) => {
      seen ??= options;
      return orig(options);
    };
    await run(two, createModelPair({ model: capturing }));

    const delegate = seen?.tools?.find((t) => t.name === DELEGATE_TOOL_NAME);
    if (delegate?.type !== "function") {
      throw new Error("expected a delegate function tool");
    }
    // JSON Schema's recursive union doesn't narrow; drill through a loose view.
    const schema = delegate.inputSchema as {
      properties?: {
        subtasks?: { items?: { properties?: Record<string, unknown> } };
      };
    };
    const subtask = schema.properties?.subtasks?.items?.properties;
    // The resolved face (matches the history call), not Phase 1's emitted one.
    expect(subtask).toHaveProperty("id");
    expect(subtask).not.toHaveProperty("localKey");
    // Declared so the call is interpretable, forbidden so the work isn't redone.
    expect(seen?.toolChoice).toEqual({ type: "none" });
  });

  it("never persists the ephemeral results message to the session", async () => {
    const { session } = await run(
      two,
      createModelPair({ model: mockModel({ text: "the answer" }) })
    );
    // Only the final reply — the rendered branch outcomes were scaffolding.
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("assistant");
  });

  it("does not re-append the user turn", async () => {
    const session = new FakeSession();
    session.appendMessage(
      deterministicSessionMessage("task:task-1:user", "user", "the request")
    );
    await run(
      two,
      createModelPair({ model: mockModel({ text: "answer" }) }),
      session
    );
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("falls back to the second model when the first throws", async () => {
    const { result } = await run(
      two,
      modelPair(
        () => {
          throw new Error("primary boom");
        },
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(result).toEqual({ status: "completed", reply: "from fallback" });
  });

  it("treats an empty response as an attempt failure", async () => {
    const { result } = await run(
      two,
      modelPair(
        () => mockModel({ text: "   " }),
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(result).toEqual({ status: "completed", reply: "from fallback" });
  });
});

describe("runCompose — degradation and replay", () => {
  const two = [
    branch({ subtaskId: 1, resultParts: [{ kind: "text", text: "alpha" }] }),
    branch({ subtaskId: 2, resultParts: [{ kind: "text", text: "beta" }] })
  ];

  it("joins the branch results when both models fail deterministically", async () => {
    const { result } = await run(
      two,
      modelPair(
        () => {
          throw new Error("kaboom");
        },
        () => {
          throw new Error("kaboom");
        }
      )
    );
    // The work is done and durable — deliver it rather than failing the task.
    expect(result).toEqual({ status: "completed", reply: "alpha\n\nbeta" });
  });

  it("notes the gap when the deterministic join covers a failure", async () => {
    const { result } = await run(
      [two[0], branch({ subtaskId: 2, status: "failed", resultParts: null })],
      modelPair(
        () => {
          throw new Error("kaboom");
        },
        () => {
          throw new Error("kaboom");
        }
      )
    );
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.reply).toContain("alpha");
    expect(result.reply).toContain("could not be completed");
  });

  it("throws a transient fault so the workflow step retries", async () => {
    await expect(
      run(
        two,
        modelPair(
          () => {
            throw new Error("3040: capacity temporarily exceeded");
          },
          () => {
            throw new Error("request timeout");
          }
        )
      )
    ).rejects.toThrow();
  });

  it("propagates a session write failure without burning a fallback inference", async () => {
    const session = new FakeSession();
    session.appendMessage = () => {
      throw new Error("sqlite write failed");
    };
    let attempts = 0;
    const counting = () => {
      attempts++;
      return mockModel({ text: "the answer" });
    };

    // A storage fault is not a model failure: the fallback must not re-run, and
    // the deterministic join must not paper over it.
    await expect(
      run(two, modelPair(counting, counting), session)
    ).rejects.toThrow(/sqlite write failed/);
    expect(attempts).toBe(1);
  });

  it("returns the durable reply on a re-run, with no inference", async () => {
    const session = new FakeSession();
    await run(
      two,
      createModelPair({ model: mockModel({ text: "first answer" }) }),
      session
    );

    const models = neverCalled();
    const { result } = await run(two, models, session);
    expect(result).toEqual({ status: "completed", reply: "first answer" });
    expect(models.calls()).toBe(0);
  });
});
