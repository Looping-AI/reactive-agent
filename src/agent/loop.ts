import type { FinishReason, StepResult, ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import type { ModelPair } from "./model";
import { MAX_STEPS } from "@/config";
import {
  assistantSessionMessage,
  toModelMessages,
  userSessionMessage
} from "./history";
import type { SessionLike } from "./session";

export const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/** Whether an error is a transient Workers-AI capacity/timeout condition. */
export function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("3040") ||
    err.message.includes("3046") ||
    err.message.toLowerCase().includes("capacity temporarily exceeded") ||
    err.message.toLowerCase().includes("request timeout")
  );
}

/** Everything a single agent turn needs, assembled by the DO before the loop runs. */
export interface RunTurnArgs {
  /** The Durable Object's one continuous Session (history + soul + memory). */
  session: SessionLike;
  /** The inbound user text (keeps its `<turn>` provenance wrapper verbatim). */
  text: string;
  /** Per-request system-prompt suffix (verified caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools, merged over the session's own `set_context` tool. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
  /**
   * Called with each **intermediate** assistant content message — text the model
   * emits in a step that also makes tool calls (`finishReason:"tool-calls"`), i.e.
   * before the final reply. Used to stream those messages out live; the final
   * reply is the return value, not an `onContent` call. `stepIndex` is the 0-based
   * step ordinal (stable enough across a primary→fallback re-run for the gateway
   * to dedupe on). Best-effort — the caller must swallow its own failures.
   */
  onContent?: (text: string, stepIndex: number) => void | Promise<void>;
}

/** A step is "intermediate" when it makes tool calls — more content follows. */
function isIntermediateStep(step: { finishReason: FinishReason }): boolean {
  return step.finishReason === "tool-calls";
}

/**
 * Returns a fresh `onStepFinish` callback for one `generateText` attempt.
 * Fires `onContent` for each intermediate step (text that accompanies tool
 * calls); the final step is skipped because its text is the return value.
 * A fresh handler per attempt resets the 0-based `stepIndex` counter so a
 * primary→fallback re-run reuses the same indices and the gateway dedupes.
 *
 * Shared with the decomposition operation ({@link file://./decompose.ts}), which
 * runs its own tool loop and streams progress the same way.
 */
export function buildIntermediateContentHandler(
  onContent: NonNullable<RunTurnArgs["onContent"]>
): (step: StepResult<ToolSet>) => Promise<void> {
  let stepIndex = 0;
  return async (step) => {
    const i = stepIndex++;
    if (!isIntermediateStep(step)) return;
    const content = step.text.trim();
    if (content) await onContent(content, i);
  };
}

/**
 * Run a single agent turn against the DO's continuous Session: append the user
 * message, run a Workers-AI `generateText` tool loop over the Session history
 * (primary → fallback model on any error), persist the assistant reply, and
 * return the final reply text. The inbound text keeps its `<turn>` provenance
 * wrapper verbatim for the model (and Phase-3 recall) to read.
 *
 * **Never throws**: a transient (capacity/timeout) failure resolves to a
 * friendly "try again" message, an unexpected failure to `unexpectedReply`, so
 * the DO's `converse()` caller always gets a string to publish.
 */
export async function runTurn(args: RunTurnArgs): Promise<string> {
  const {
    session,
    text,
    systemSuffix,
    tools: extraTools,
    models,
    onContent
  } = args;
  let modelId = models.primaryId();

  try {
    await session.appendMessage(userSessionMessage(text));
    const history = await session.getHistory();
    const system = (await session.refreshSystemPrompt()) + systemSuffix;
    const tools = { ...(await session.tools()), ...extraTools };

    const generateArgs = {
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // We do our own primary → fallback recovery below, so disable the SDK's
      // per-model exponential-backoff retries — they'd only add latency on a
      // hard failure and duplicate our fallback.
      maxRetries: 0
    };

    // Stream each intermediate content message (text on a step that also makes
    // tool calls) as it finishes. The final step (`stop`/`length`) is the reply
    // and is delivered via the return value, not here. Each attempt gets a fresh
    // handler so the 0-based stepIndex counter resets; a primary→fallback re-run
    // reuses the same index per position and the gateway dedupes by id.
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: models.primary(),
        ...generateArgs,
        onStepFinish: onContent
          ? buildIntermediateContentHandler(onContent)
          : undefined
      });
    } catch (primaryErr) {
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        { model: modelId, error: String(primaryErr) }
      );
      modelId = models.fallbackId();
      result = await generateText({
        model: models.fallback(),
        ...generateArgs,
        onStepFinish: onContent
          ? buildIntermediateContentHandler(onContent)
          : undefined
      });
    }

    const replyText = result.text.trim();
    const finishReason = result.finishReason;

    if (!replyText || finishReason === "length") {
      if (finishReason === "length") {
        console.warn(
          "[agent-loop] model response truncated (finish_reason=length)",
          { model: modelId }
        );
      } else {
        console.warn("[agent-loop] empty response from model", {
          model: modelId,
          finishReason
        });
      }
      return TRANSIENT_REPLY;
    }

    await session.appendMessage(assistantSessionMessage(replyText));
    return replyText;
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    return isTransientAiError(err) ? TRANSIENT_REPLY : args.unexpectedReply;
  }
}
