import type { FinishReason, StepResult, ToolSet } from "ai";

/**
 * Shared Workers-AI plumbing for the agent's inference operations — the pieces
 * every model call needs regardless of *which* operation it belongs to.
 *
 * The operations themselves are deliberately separate, not layered on a common
 * loop: the main agent's Session-coupled phases live in
 * {@link file://./decompose.ts decompose.ts} and {@link file://./compose.ts
 * compose.ts}, and the Session-less subagent loop in
 * {@link file://../subagent/run.ts run.ts}. They share error classification and
 * progress streaming; their control flow has nothing in common worth abstracting.
 */

/**
 * Called with each **intermediate** assistant content message — text the model
 * emits in a step that also makes tool calls (`finishReason:"tool-calls"`), i.e.
 * before the final reply. Used to stream those messages out live; the final reply
 * is the operation's return value, not an `onContent` call. `stepIndex` is the
 * 0-based step ordinal (stable enough across a primary→fallback re-run for the
 * gateway to dedupe on). Best-effort — the caller must swallow its own failures.
 */
export type OnContent = (
  text: string,
  stepIndex: number
) => void | Promise<void>;

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

/** A step is "intermediate" when it makes tool calls — more content follows. */
function isIntermediateStep(step: { finishReason: FinishReason }): boolean {
  return step.finishReason === "tool-calls";
}

/**
 * Returns a fresh `onStepFinish` callback for one `generateText` attempt.
 * Fires `onContent` for each intermediate step (text that accompanies tool
 * calls); the final step is skipped because its text is the operation's return
 * value. A fresh handler per attempt resets the 0-based `stepIndex` counter so a
 * primary→fallback re-run reuses the same indices and the gateway dedupes.
 */
export function buildIntermediateContentHandler(
  onContent: OnContent
): (step: StepResult<ToolSet>) => Promise<void> {
  let stepIndex = 0;
  return async (step) => {
    const i = stepIndex++;
    if (!isIntermediateStep(step)) return;
    const content = step.text.trim();
    if (content) await onContent(content, i);
  };
}
