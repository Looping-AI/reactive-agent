import type { LanguageModel, ModelMessage, StepResult, ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import { isTransientAiError } from "@/agent/inference";
import type { ModelPair } from "@/agent/model";
import type {
  ProgressEvent,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  RecipeLimits
} from "@/agent/subtasks/types";
import { renderSubagentPrompt } from "./prompt";

/**
 * The resumable execution runner — ONE loop for every Recipe, from a single-shot
 * default Subtask to a thousand-turn game. It runs the model/tool loop in durable
 * **chunks**: each call advances up to `turnsPerChunk` turns (or `chunkSoftMs`
 * wall-clock, or until a tool emits progress), checkpoints its rolling state after
 * every turn, and returns either a terminal result or a "not done" yield. The
 * facet persists the state between chunks and the Workflow runs each chunk as its
 * own durable, retryable step — so no single step ever approaches the platform
 * step timeout, and a crash loses at most the in-flight turn.
 *
 * Domain behavior lives entirely in the tool families; this runner is agnostic of
 * what work happens beneath it. State that must outlive the small rolling context
 * window is the recipe's responsibility to persist to its workspace.
 */

/** The rolling state carried across a run's chunks (persisted by the facet). */
export interface ChunkRunState {
  /** Windowed conversation so far (system is supplied separately, not stored here). */
  messages: ModelMessage[];
  /** Total model turns (tool-loop steps) across every chunk — bounds `maxTurns`. */
  turns: number;
  /** Total `generateText` invocations (including fallbacks and summarization). */
  llmCalls: number;
  /** Wall-clock start of the whole execution (for the metrics footer). */
  startedAtMs: number;
}

/** Everything one chunk needs, assembled by the facet (or a test) each call. */
export interface ChunkRunDeps {
  system: string;
  /** The rendered initial user message; seeds a fresh run's first chunk. */
  seedPrompt: string;
  models: ModelPair;
  tools: ToolSet;
  limits: RecipeLimits;
  historyWindow: number;
  reportMetrics: boolean;
  now: () => number;
  /** Shared sink the tool families push progress events into (fresh per chunk). */
  progress: ProgressEvent[];
  /** Persist rolling state after every model turn — the crash-safety checkpoint. */
  checkpoint: (state: ChunkRunState) => void | Promise<void>;
}

export interface ChunkRunOutput {
  outcome: RecipeChunkResult;
  state: ChunkRunState;
}

type ChunkAttempt =
  | { kind: "completed"; text: string; modelId: string }
  | { kind: "yield" }
  | { kind: "failed"; diagnostic: string; error?: unknown; modelId: string };

/**
 * Trim the conversation to the most recent `window` turns (plus the seed message),
 * cutting at an assistant boundary so no tool-result message is left orphaned.
 * Older turns fall out of context — the recipe's soul directs the model to persist
 * anything durable to its workspace, which the window never touches.
 */
export function windowMessages(
  messages: ModelMessage[],
  window: number
): ModelMessage[] {
  if (messages.length <= 1) return messages;
  const assistantIdx: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") assistantIdx.push(i);
  }
  if (assistantIdx.length <= window) return messages;
  const start = assistantIdx[assistantIdx.length - window];
  return [messages[0], ...messages.slice(start)];
}

/** Human-readable elapsed time for the metrics footer. */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function metricsFooter(state: ChunkRunState, now: number): string {
  return (
    `\n\n---\nRan ${state.turns} model turn(s) across ${state.llmCalls} model ` +
    `call(s) in ${formatDuration(now - state.startedAtMs)}.`
  );
}

function completed(
  state: ChunkRunState,
  deps: ChunkRunDeps,
  text: string,
  modelId: string
): ChunkRunOutput {
  const finalText = deps.reportMetrics
    ? text + metricsFooter(state, deps.now())
    : text;
  return {
    outcome: {
      done: true,
      result: {
        status: "completed",
        resultParts: [{ kind: "text", text: finalText }],
        modelId
      },
      progress: deps.progress
    },
    state
  };
}

/**
 * Run one durable chunk. Returns a terminal result (natural completion, budget
 * exhaustion, or exhausted models) or a `done: false` yield with the progress
 * emitted this chunk. Throws only on a transient platform fault, so the Workflow
 * step retries and resumes from the last checkpoint.
 */
export async function runResumableChunk(
  prev: ChunkRunState | null,
  deps: ChunkRunDeps
): Promise<ChunkRunOutput> {
  const state: ChunkRunState = prev ?? {
    messages: [{ role: "user", content: deps.seedPrompt }],
    turns: 0,
    llmCalls: 0,
    startedAtMs: deps.now()
  };

  const chunkStartMs = deps.now();

  const onStepFinish = async (step: StepResult<ToolSet>): Promise<void> => {
    state.turns += 1;
    state.messages = windowMessages(
      [...state.messages, ...step.response.messages],
      deps.historyWindow
    );
    await deps.checkpoint(state);
  };

  const stopWhen = [
    stepCountIs(
      Math.max(
        1,
        Math.min(deps.limits.turnsPerChunk, deps.limits.maxTurns - state.turns)
      )
    ),
    () => deps.now() - chunkStartMs >= deps.limits.chunkSoftMs,
    () => deps.progress.length > 0
  ];

  const attempt = async (
    model: () => LanguageModel,
    modelId: string
  ): Promise<ChunkAttempt> => {
    state.llmCalls += 1;
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: model(),
        system: deps.system,
        messages: state.messages,
        tools: deps.tools,
        stopWhen,
        // Primary → fallback recovery is manual; SDK backoff would only add latency.
        maxRetries: 0,
        onStepFinish
      });
    } catch (error) {
      return { kind: "failed", diagnostic: String(error), error, modelId };
    }
    if (result.finishReason === "length") {
      return {
        kind: "failed",
        diagnostic: "truncated (finish_reason=length)",
        modelId
      };
    }
    if (result.finishReason === "stop") {
      const text = result.text.trim();
      return text === ""
        ? { kind: "failed", diagnostic: "empty final reply", modelId }
        : { kind: "completed", text, modelId };
    }
    // Not a final answer (e.g. finish_reason=tool-calls): a stop condition fired
    // mid-loop — the chunk yielded a durable boundary with more work to do.
    return { kind: "yield" };
  };

  let a = await attempt(deps.models.primary, deps.models.primaryId());
  if (a.kind === "failed") {
    console.warn("[recipe-runner] primary attempt failed, trying fallback", {
      model: a.modelId,
      diagnostic: a.diagnostic
    });
    const primaryFailure = a;
    a = await attempt(deps.models.fallback, deps.models.fallbackId());

    if (a.kind === "failed") {
      // Both attempts failed. A transient fault anywhere means a retry could
      // succeed — throw it for the Workflow step (most recent first).
      for (const failed of [a, primaryFailure]) {
        if (failed.error !== undefined && isTransientAiError(failed.error)) {
          throw failed.error;
        }
      }
      return {
        outcome: {
          done: true,
          result: {
            status: "failed",
            error:
              `recipe exhausted: primary (${primaryFailure.modelId}): ` +
              `${primaryFailure.diagnostic}; fallback (${a.modelId}): ${a.diagnostic}`,
            modelId: a.modelId
          },
          progress: deps.progress
        },
        state
      };
    }
  }

  if (a.kind === "completed") return completed(state, deps, a.text, a.modelId);

  // The chunk yielded. If the turn budget is spent, force a final summary so the
  // run still returns useful output; otherwise ask the Workflow for another chunk.
  if (state.turns >= deps.limits.maxTurns) {
    return summarizeBudget(state, deps);
  }
  return { outcome: { done: false, progress: deps.progress }, state };
}

/**
 * The turn budget is exhausted mid-loop: run one final no-tools call asking the
 * model to produce its answer/report from the work so far. Primary → fallback,
 * same transient/deterministic split. This is what makes "uncapped but bounded"
 * safe — the ceiling yields a report instead of a dropped run.
 */
async function summarizeBudget(
  state: ChunkRunState,
  deps: ChunkRunDeps
): Promise<ChunkRunOutput> {
  const messages: ModelMessage[] = [
    ...state.messages,
    {
      role: "user",
      content:
        "You have reached your turn budget and can take no more actions. " +
        "Write your final answer or report now, based on the work so far."
    }
  ];

  const summarize = async (
    model: () => LanguageModel,
    modelId: string
  ): Promise<ChunkAttempt> => {
    state.llmCalls += 1;
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: model(),
        system: deps.system,
        messages,
        stopWhen: stepCountIs(1),
        maxRetries: 0
      });
    } catch (error) {
      return { kind: "failed", diagnostic: String(error), error, modelId };
    }
    const text = result.text.trim();
    return text === ""
      ? { kind: "failed", diagnostic: "empty summary", modelId }
      : { kind: "completed", text, modelId };
  };

  let a = await summarize(deps.models.primary, deps.models.primaryId());
  if (a.kind === "failed") {
    const primaryFailure = a;
    a = await summarize(deps.models.fallback, deps.models.fallbackId());
    if (a.kind === "failed") {
      for (const failed of [a, primaryFailure]) {
        if (failed.error !== undefined && isTransientAiError(failed.error)) {
          throw failed.error;
        }
      }
      // Even the summary failed: return a plain budget-exhausted notice.
      const text = "Reached the turn budget without producing a final report.";
      return completed(state, deps, text, a.modelId);
    }
  }
  return a.kind === "completed"
    ? completed(state, deps, a.text, a.modelId)
    : completed(
        state,
        deps,
        "Reached the turn budget.",
        deps.models.fallbackId()
      );
}

/** Everything a whole-run (non-chunked) execution needs — for tests and callers
 * that want a single terminal result rather than driving chunks themselves. */
export interface RecipeRunDeps {
  models: ModelPair;
  tools: ToolSet;
  now?: () => number;
}

/**
 * Run one recipe execution to a terminal result, driving {@link runResumableChunk}
 * chunk by chunk in memory. The default recipe finishes in a single chunk
 * (`maxTurns === turnsPerChunk`); a long recipe loops until done. Used by tests
 * and any caller wanting the whole outcome; the facet drives chunks durably
 * instead, for crash-safety across the Workflow.
 *
 * Throws only on a transient platform fault (as {@link runResumableChunk} does).
 */
export async function runRecipeExecution(
  request: RecipeExecutionRequest,
  deps: RecipeRunDeps
): Promise<RecipeExecutionResult> {
  if (request.prompt.trim() === "") {
    return { status: "failed", error: "empty subtask prompt", modelId: null };
  }

  const { system, prompt } = renderSubagentPrompt(request);
  const now = deps.now ?? Date.now;

  let state: ChunkRunState | null = null;
  // Bounded by maxTurns / turnsPerChunk (+1) — a chunk always advances ≥1 turn
  // unless it completes, so this can never spin.
  const maxChunks =
    Math.ceil(
      request.recipe.limits.maxTurns / request.recipe.limits.turnsPerChunk
    ) + 2;

  for (let chunk = 0; chunk < maxChunks; chunk++) {
    const chunkDeps: ChunkRunDeps = {
      system,
      seedPrompt: prompt,
      models: deps.models,
      tools: deps.tools,
      limits: request.recipe.limits,
      historyWindow: request.recipe.historyWindow,
      reportMetrics: request.recipe.reportMetrics,
      now,
      progress: [],
      checkpoint: () => {}
    };
    const { outcome, state: next } = await runResumableChunk(state, chunkDeps);
    if (outcome.done) return outcome.result;
    state = next;
  }

  return {
    status: "failed",
    error: `recipe did not terminate within ${maxChunks} chunks`,
    modelId: null
  };
}
