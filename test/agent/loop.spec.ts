import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { runTurn, TRANSIENT_REPLY } from "@/agent/loop";
import { createModelPair, type ModelPair } from "@/agent/model";
import { sessionText } from "@/agent/history";
import { FakeSession } from "../helpers/fake-session";
import { mockModel } from "./mock-model";

/** Minimal real tool used to exercise the multi-step tool-call loop. */
const ECHO_TOOL: ToolSet = {
  echo: tool({
    description: "Echoes its input back.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => text
  })
};

/** The verified-caller suffix a turn appends to the Session's soul block. */
const CALLER_SUFFIX = "\n\nCalling agent instance: Ada.";

/** Reply the DO returns on an unexpected (non-transient) failure — asserted by substring. */
const UNEXPECTED_REPLY =
  "Sorry, I hit an unexpected error handling that request.";

function run(
  models: { model: LanguageModel; fallbackModel?: LanguageModel },
  text = "hello",
  extraTools: ToolSet = {}
) {
  const session = new FakeSession();
  return runTurn({
    session,
    text,
    systemSuffix: CALLER_SUFFIX,
    tools: extraTools,
    models: createModelPair(models),
    unexpectedReply: UNEXPECTED_REPLY
  }).then((reply) => ({ reply, session }));
}

/**
 * Build a `ModelPair` from raw factory functions. The error-path tests throw
 * *from the factory* (before `generateText` is ever called) to exercise the
 * fallback / outer-catch branches — rather than passing a model whose
 * `doGenerate` rejects into `generateText`, which leaks an unhandled rejection
 * through the AI SDK's telemetry span that workerd flags as a failure.
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

/** Drive a turn with a pre-built `ModelPair` (used by the error-path tests). */
function runPair(models: ModelPair, text = "hello") {
  return runTurn({
    session: new FakeSession(),
    text,
    systemSuffix: CALLER_SUFFIX,
    tools: {},
    models,
    unexpectedReply: UNEXPECTED_REPLY
  });
}

describe("runTurn — happy path", () => {
  it("returns the model's reply text", async () => {
    const { reply } = await run({ model: mockModel({ text: "Hi Ada!" }) });
    expect(reply).toBe("Hi Ada!");
  });

  it("persists the user turn and the assistant reply to the session", async () => {
    const { session } = await run({ model: mockModel({ text: "remembered" }) });
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[0])).toBe("hello");
    expect(sessionText(session.messages[1])).toBe("remembered");
  });

  it("feeds prior history + soul + verified caller context to the model", async () => {
    let seenPrompt = "";
    const capturing = mockModel({ text: "ok" });
    const orig = capturing.doGenerate.bind(capturing);
    capturing.doGenerate = async (options: Parameters<typeof orig>[0]) => {
      seenPrompt = JSON.stringify(options.prompt);
      return orig(options);
    };
    await run({ model: capturing });
    // The Session's soul + memory block (system) and the verified caller suffix.
    expect(seenPrompt).toContain("SOUL BLOCK");
    expect(seenPrompt).toContain("Calling agent instance: Ada");
    // The inbound user turn reached the model as history.
    expect(seenPrompt).toContain("hello");
  });

  it("runs a tool call then returns the follow-up text", async () => {
    const { reply } = await run(
      {
        model: mockModel(
          { toolCall: { toolName: "echo", input: { text: "ping" } } },
          { text: "I echoed: ping" }
        )
      },
      "hello",
      ECHO_TOOL
    );
    expect(reply).toBe("I echoed: ping");
  });

  it("streams intermediate content (text on a tool-call step) via onContent, not the final reply", async () => {
    const streamed: Array<{ text: string; index: number }> = [];
    const reply = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: ECHO_TOOL,
      models: createModelPair({
        model: mockModel(
          {
            text: "thinking out loud",
            toolCall: { toolName: "echo", input: { text: "ping" } }
          },
          { text: "final answer" }
        )
      }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text, index) => {
        streamed.push({ text, index });
      }
    });
    expect(reply).toBe("final answer");
    // The intermediate content streamed once (step 0); the final reply did not.
    expect(streamed).toEqual([{ text: "thinking out loud", index: 0 }]);
  });

  it("does not stream when the turn is a single content reply (no tool call)", async () => {
    const streamed: string[] = [];
    const reply = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: {},
      models: createModelPair({ model: mockModel({ text: "just this" }) }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text) => {
        streamed.push(text);
      }
    });
    expect(reply).toBe("just this");
    expect(streamed).toEqual([]);
  });
});

describe("runTurn — resilience", () => {
  it("falls back to the secondary model when the primary throws", async () => {
    const reply = await runPair(
      modelPair(
        () => {
          throw new Error("primary boom");
        },
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(reply).toBe("from fallback");
  });

  it("returns the transient message when both models are over capacity", async () => {
    const reply = await runPair(
      modelPair(
        () => {
          throw new Error("capacity temporarily exceeded");
        },
        () => {
          throw new Error("capacity temporarily exceeded");
        }
      )
    );
    expect(reply).toBe(TRANSIENT_REPLY);
  });

  it("returns the transient message when the model returns empty text", async () => {
    const { reply } = await run({ model: mockModel({ text: "" }) });
    expect(reply).toBe(TRANSIENT_REPLY);
  });

  it("returns the unexpected-error reply on a non-transient failure", async () => {
    const reply = await runPair(
      modelPair(
        () => {
          throw new Error("kaboom");
        },
        () => {
          throw new Error("kaboom");
        }
      )
    );
    expect(reply).not.toBe(TRANSIENT_REPLY);
    expect(reply).toBe(UNEXPECTED_REPLY);
  });
});
