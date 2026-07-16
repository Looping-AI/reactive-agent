import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import {
  joinSuccessfulBranches,
  renderCompositionMessage,
  runCompose
} from "@/agent/compose";
import { createModelPair, type ModelPair } from "@/agent/model";
import {
  deterministicSessionMessage,
  finalReplyMessageId,
  sessionText
} from "@/agent/history";
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

describe("renderCompositionMessage", () => {
  it("labels the results as generated output, not conversation evidence", () => {
    const rendered = renderCompositionMessage([branch()]);
    expect(rendered).toContain("generated output");
    expect(rendered).toContain("not conversation evidence");
  });

  it("includes each completed branch's text", () => {
    const rendered = renderCompositionMessage([
      branch({ subtaskId: 1, resultParts: [{ kind: "text", text: "alpha" }] }),
      branch({ subtaskId: 2, resultParts: [{ kind: "text", text: "beta" }] })
    ]);
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("beta");
  });

  it("names failed and skipped branches so they can be disclosed", () => {
    const rendered = renderCompositionMessage([
      branch({ subtaskId: 1 }),
      branch({
        subtaskId: 2,
        status: "failed",
        resultParts: null,
        error: "boom"
      }),
      branch({ subtaskId: 3, status: "skipped", resultParts: null })
    ]);
    expect(rendered).toContain("[subtask 2] (research) failed");
    expect(rendered).toContain("[subtask 3] (research) skipped");
  });

  it("keeps internal diagnostics out of the model's view", () => {
    const rendered = renderCompositionMessage([
      branch({
        status: "failed",
        resultParts: null,
        error: "stack trace: connection refused at 10.0.0.1"
      })
    ]);
    expect(rendered).not.toContain("connection refused");
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
