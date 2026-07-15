import type { ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import { MAX_STEPS } from "@/config";
import { isTransientAiError } from "@/agent/loop";
import type { ModelPair } from "@/agent/model";
import type {
  RecipeExecutionRequest,
  RecipeExecutionResult
} from "@/agent/subtasks/types";
import { renderSubagentPrompt } from "./prompt";

/**
 * Everything one recipe execution needs, assembled by the subagent from the
 * validated Recipe: the id-parameterized model pair and the toolset built from
 * the Recipe's tool families. Injected so the loop tests without a real model.
 */
export interface RecipeRunDeps {
  models: ModelPair;
  tools: ToolSet;
}

type Attempt =
  | { ok: true; text: string }
  | { ok: false; diagnostic: string; error?: unknown };

/**
 * One bounded `generateText` attempt. Succeeds only with a non-empty trimmed
 * final text that wasn't truncated; a thrown error (including a synchronous
 * model-factory throw) becomes a diagnosed failure carrying the original error
 * for the transient/deterministic split.
 */
async function runAttempt(
  model: ModelPair["primary"],
  args: {
    system: string;
    prompt: string;
    tools: ToolSet;
    stopWhen: ReturnType<typeof stepCountIs>;
    maxRetries: number;
  }
): Promise<Attempt> {
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({ model: model(), ...args });
  } catch (error) {
    return { ok: false, diagnostic: String(error), error };
  }
  if (result.finishReason === "length") {
    return {
      ok: false,
      diagnostic: "truncated response (finish_reason=length)"
    };
  }
  const text = result.text.trim();
  if (text === "") {
    return {
      ok: false,
      diagnostic: `empty response (finish_reason=${result.finishReason})`
    };
  }
  return { ok: true, text };
}

/**
 * Run one Session-less recipe execution: render the sectioned invocation, run
 * the bounded model/tool loop on the primary model, fall back on any failure,
 * and return a terminal result. Unlike `runTurn` this loop has no Session —
 * nothing is appended anywhere; the caller owns persistence.
 *
 * **Throws only on a transient platform fault** (Workers-AI capacity/timeout)
 * so the enclosing Workflow step retries. Every deterministic outcome —
 * including a fully exhausted Recipe — is a returned `failed` result: retrying
 * identical inputs would only repeat it.
 */
export async function runRecipeExecution(
  request: RecipeExecutionRequest,
  deps: RecipeRunDeps
): Promise<RecipeExecutionResult> {
  const { models, tools } = deps;
  if (request.prompt.trim() === "") {
    return { status: "failed", error: "empty subtask prompt", modelId: null };
  }

  const { system, prompt } = renderSubagentPrompt(request);
  const generateArgs = {
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    // Primary → fallback recovery is handled here; the SDK's per-model
    // exponential-backoff retries would only add latency on a hard failure.
    maxRetries: 0
  };

  const primaryAttempt = await runAttempt(models.primary, generateArgs);
  if (primaryAttempt.ok) {
    return {
      status: "completed",
      resultParts: [{ kind: "text", text: primaryAttempt.text }],
      modelId: models.primaryId()
    };
  }
  console.warn("[recipe-subagent] primary attempt failed, trying fallback", {
    model: models.primaryId(),
    diagnostic: primaryAttempt.diagnostic
  });

  const fallbackAttempt = await runAttempt(models.fallback, generateArgs);
  if (fallbackAttempt.ok) {
    return {
      status: "completed",
      resultParts: [{ kind: "text", text: fallbackAttempt.text }],
      modelId: models.fallbackId()
    };
  }

  // Both attempts failed. A transient fault anywhere means a retry could
  // succeed — throw it for the Workflow step to retry (most recent first).
  for (const failed of [fallbackAttempt, primaryAttempt]) {
    if (failed.error !== undefined && isTransientAiError(failed.error)) {
      throw failed.error;
    }
  }

  return {
    status: "failed",
    error:
      `recipe exhausted: primary (${models.primaryId()}): ` +
      `${primaryAttempt.diagnostic}; fallback (${models.fallbackId()}): ` +
      fallbackAttempt.diagnostic,
    modelId: models.fallbackId()
  };
}
