import { MockLanguageModelV3 } from "ai/test";

/**
 * Test doubles for the LLM. Lets the tool-loop / executor specs run the real
 * `generateText` machinery (tool execution, multi-step, fallback) against a
 * scripted model with no network or `AI` binding.
 */

/** Zeroed usage block satisfying the LanguageModelV3 result shape. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

export interface MockStep {
  /**
   * Assistant text for this step. On its own → finishReason "stop" (final reply).
   * Alongside `toolCall` → the intermediate content emitted before a tool call.
   */
  text?: string;
  /** Emit a tool call (finishReason "tool-calls"); may accompany `text`. */
  toolCall?: { toolName: string; input?: unknown };
}

function stepResult(step: MockStep) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  > = [];
  // Keep the empty-string text part so a `{ text: "" }` step still yields "".
  if (step.text !== undefined) content.push({ type: "text", text: step.text });
  if (step.toolCall) {
    content.push({
      type: "tool-call",
      toolCallId: crypto.randomUUID(),
      toolName: step.toolCall.toolName,
      input: JSON.stringify(step.toolCall.input ?? {})
    });
  }
  const unified = step.toolCall ? ("tool-calls" as const) : ("stop" as const);
  return {
    content,
    finishReason: { unified, raw: undefined },
    usage: USAGE,
    warnings: []
  };
}

/**
 * A mock model that returns each step in sequence — one per `generateText` call.
 * Uses the function form (with our own counter) rather than the array form, whose
 * call-count indexing is off by one in this SDK version. Extra calls repeat the
 * last step.
 */
export function mockModel(...steps: MockStep[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => stepResult(steps[Math.min(i++, steps.length - 1)])
  });
}
