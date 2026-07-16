import { Agent } from "agents";
import { z } from "zod";
import { createModelPair, type ModelPair } from "@/agent/model";
import { buildRecipeTools } from "@/agent/tools";
import { RecipeValidationError, validateRecipe } from "@/agent/subtasks/recipe";
import type {
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskId
} from "@/agent/subtasks/types";
import { fingerprintRequest } from "./fingerprint";
import { runRecipeExecution } from "./run";

/**
 * Message prefix of the error thrown when a child that already holds a cached
 * terminal result receives a *different* request. Custom error classes don't
 * survive DO RPC, so this prefix is the cross-boundary contract: it signals a
 * parent lifecycle bug — stale children must be deleted before a genuinely new
 * execution — and a Workflow retry after the parent's cleanup will succeed.
 */
export const FINGERPRINT_MISMATCH =
  "recipe-subagent: request fingerprint mismatch";

/** Deterministic managed-child name for one Subtask execution (shared with C3). */
export function subagentName(taskId: string, subtaskId: SubtaskId): string {
  return `subtask:${taskId}:${subtaskId}`;
}

/** Zod mirror of {@link RecipeExecutionResult} for parsing the cached JSON. */
const cachedResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    resultParts: z
      .array(z.object({ kind: z.literal("text"), text: z.string() }))
      .min(1),
    modelId: z.string()
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    modelId: z.string().nullable()
  })
]);

/**
 * `RecipeSubagent` — the isolated, stateless managed child that executes one
 * Subtask under a resolved Recipe. Created as an Agents SDK sub-agent (facet)
 * beneath the caller's `ReactiveAgent`, so it needs no wrangler Durable Object
 * binding and no `new_sqlite_classes` entry; it must only be exported from the
 * worker entry (`src/index.ts`) so `ctx.exports` can resolve it by class name.
 *
 * It never constructs a Session, never reads parent history beyond the
 * references supplied on its request, never uses recall or durable memory, and
 * never resolves a Recipe itself — it defensively re-validates the resolved
 * Recipe the parent sends and accepts no configuration beyond it.
 *
 * Retry safety: the child persists exactly one terminal result in its own
 * SQLite, keyed by the deterministic request fingerprint. A retry with the
 * same fingerprint returns the cached result without re-running inference; a
 * different request for the same child name is rejected
 * ({@link FINGERPRINT_MISMATCH}). Transient platform faults throw and cache
 * nothing, so the enclosing Workflow step can retry inference. The parent
 * deletes the child (`deleteSubAgent`) only after its durable copy of the
 * result succeeds, which wipes this storage.
 */
export class RecipeSubagent extends Agent<Env> {
  /**
   * Test-only `ModelPair` injection (a field, so never on the RPC stub).
   * A whole pair — rather than model instances — so error-path tests can throw
   * synchronously from the pair's factories, the repo convention (a rejecting
   * `doGenerate` inside `generateText` leaks an unhandled rejection through
   * the AI SDK telemetry span that workerd flags as a failure).
   */
  modelsOverride?: ModelPair;

  async onStart(): Promise<void> {
    this.ensureCacheTable();
  }

  /**
   * Idempotent schema bootstrap. Also called lazily from `execute()` so
   * `runInDurableObject`-style tests reach a ready table without RPC dispatch
   * (mirroring how `AgentDB` migrates on construction).
   */
  private ensureCacheTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS execution_cache (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
  }

  /**
   * Execute one Subtask under the parent's already-resolved Recipe and return
   * the terminal outcome. Deterministic outcomes — completed, or failed via a
   * disabled Recipe / empty prompt / exhausted models — are cached and
   * replayed; only transient platform faults throw.
   */
  async execute(
    request: RecipeExecutionRequest
  ): Promise<RecipeExecutionResult> {
    this.ensureCacheTable();
    const fingerprint = await fingerprintRequest(request);

    const cached = this.sql<{ fingerprint: string; result_json: string }>`
      SELECT fingerprint, result_json FROM execution_cache WHERE slot = 1
    `[0];
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error(
          `${FINGERPRINT_MISMATCH}: this child already holds a terminal ` +
            "result for a different request; the parent must delete a stale " +
            "child before starting a genuinely new execution"
        );
      }
      return cachedResultSchema.parse(JSON.parse(cached.result_json));
    }

    let result: RecipeExecutionResult;
    try {
      const recipe = validateRecipe(request.recipe);
      const models =
        this.modelsOverride ??
        createModelPair({
          primaryModelId: recipe.primaryModelId,
          fallbackModelId: recipe.fallbackModelId
        });
      const tools = buildRecipeTools(recipe.toolFamilies, this.env.BROWSER);
      // A transient platform fault propagates from here with nothing cached,
      // so a Workflow retry re-runs inference by design.
      result = await runRecipeExecution(
        { ...request, recipe },
        { models, tools }
      );
    } catch (error) {
      if (!(error instanceof RecipeValidationError)) throw error;
      // A disabled Recipe is a deterministic caller bug — terminal, cacheable.
      result = { status: "failed", error: error.message, modelId: null };
    }

    this.sql`
      INSERT INTO execution_cache (slot, fingerprint, result_json, created_at)
      VALUES (1, ${fingerprint}, ${JSON.stringify(result)}, ${Date.now()})
      ON CONFLICT (slot) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `;
    return result;
  }
}
