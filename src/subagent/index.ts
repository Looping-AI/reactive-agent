import { Agent } from "agents";
import { z } from "zod";
import type { Workspace } from "@cloudflare/shell";
import { createModelPair, type ModelPair } from "@/agent/model";
import { buildRecipeTools } from "@/agent/tools";
import {
  RecipeValidationError,
  validateRecipe
} from "@/agent/subtasks/registry";
import type {
  ProgressEvent,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskId
} from "@/agent/subtasks/types";
import { renderSubagentPrompt } from "./prompt";
import { createDurableWorkspace, makeWorkspaceHandle } from "./workspace";
import { fingerprintRequest } from "./fingerprint";
import { runResumableChunk, type ChunkRunState } from "./run";

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
 * Retry safety: the child persists at most one terminal result in its own
 * SQLite, keyed by the deterministic request fingerprint, plus the rolling
 * `run_state` of an in-progress multi-chunk run. A retry with the same
 * fingerprint replays the terminal result or resumes the run without repeating
 * completed work; a different request for the same child name is rejected
 * ({@link FINGERPRINT_MISMATCH}). Transient platform faults throw and cache
 * nothing, so the enclosing Workflow step can retry. The parent deletes the child
 * (`deleteSubAgent`) only after its durable copy of the result succeeds, which
 * wipes this storage — the workspace and run state included.
 *
 * Not "stateless" like the single-shot original: it owns per-execution durable
 * state (the workspace and the run checkpoint), scoped to one execution and swept
 * with the child.
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

  private _workspace?: Workspace;

  async onStart(): Promise<void> {
    this.ensureTables();
  }

  /**
   * Idempotent schema bootstrap. Also called lazily from the RPCs so
   * `runInDurableObject`-style tests reach ready tables without RPC dispatch
   * (mirroring how `AgentDB` migrates on construction).
   */
  private ensureTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS execution_cache (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS run_state (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        fingerprint TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
  }

  /** The recipe's durable workspace, backed by this facet's own SQLite storage. */
  private workspace(): Workspace {
    return (this._workspace ??= createDurableWorkspace(
      this.ctx.storage.sql,
      () => this.name
    ));
  }

  /**
   * Execute one durable chunk of a Subtask under the parent's resolved Recipe.
   *
   * A terminal outcome (completed / failed) is cached and replayed on retry. A
   * mid-run chunk persists its rolling state to `run_state` and returns a
   * `done: false` yield for the Workflow to run another chunk. `chunk` is a
   * separate argument — never part of `request` — so every chunk fingerprints
   * identically and the cache/resume keys line up. Only transient platform faults
   * throw (nothing cached), so a Workflow retry resumes from the last checkpoint.
   */
  async executeChunk(
    request: RecipeExecutionRequest,
    _chunk: number
  ): Promise<RecipeChunkResult> {
    this.ensureTables();
    const fingerprint = await fingerprintRequest(request);

    // A terminal result already exists → replay it (idempotent retry).
    const cached = this.sql<{ fingerprint: string; result_json: string }>`
      SELECT fingerprint, result_json FROM execution_cache WHERE slot = 1
    `[0];
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw mismatch("terminal");
      return {
        done: true,
        result: cachedResultSchema.parse(JSON.parse(cached.result_json)),
        progress: []
      };
    }

    // Validate the recipe up front; a disabled recipe / empty prompt is a
    // deterministic, cacheable terminal failure with no model call.
    let recipe;
    try {
      recipe = validateRecipe(request.recipe);
    } catch (error) {
      if (!(error instanceof RecipeValidationError)) throw error;
      return this.cacheTerminal(fingerprint, {
        status: "failed",
        error: error.message,
        modelId: null
      });
    }
    if (request.prompt.trim() === "") {
      return this.cacheTerminal(fingerprint, {
        status: "failed",
        error: "empty subtask prompt",
        modelId: null
      });
    }

    // Resume an in-progress run, guarding against a stale child holding a
    // *different* run (the same reuse hazard the terminal cache guards).
    const saved = this.sql<{ fingerprint: string; state_json: string }>`
      SELECT fingerprint, state_json FROM run_state WHERE slot = 1
    `[0];
    if (saved && saved.fingerprint !== fingerprint)
      throw mismatch("in-progress");
    const prev: ChunkRunState | null = saved
      ? (JSON.parse(saved.state_json) as ChunkRunState)
      : null;

    const models =
      this.modelsOverride ??
      createModelPair({
        primaryModelId: recipe.primaryModelId,
        fallbackModelId: recipe.fallbackModelId
      });
    const workspace = makeWorkspaceHandle(this.workspace());
    const progress: ProgressEvent[] = [];
    const { tools } = buildRecipeTools(recipe.toolFamilies, {
      env: this.env,
      workspace,
      emitProgress: (event) => progress.push(event)
    });
    const { system, prompt } = renderSubagentPrompt({ ...request, recipe });

    const { outcome, state } = await runResumableChunk(prev, {
      system,
      seedPrompt: prompt,
      models,
      tools,
      limits: recipe.limits,
      historyWindow: recipe.historyWindow,
      reportMetrics: recipe.reportMetrics,
      now: () => Date.now(),
      progress,
      checkpoint: (s) => this.saveRunState(fingerprint, s)
    });
    // The per-step checkpoint already ran; persist the final state too so a chunk
    // that yielded without a completed step still advances durably.
    this.saveRunState(fingerprint, state);

    if (outcome.done) {
      return this.cacheTerminal(fingerprint, outcome.result, outcome.progress);
    }
    return { done: false, progress: outcome.progress };
  }

  /**
   * Best-effort cleanup on cancellation: rebuild the recipe's tool families and
   * run their `abort` hooks (e.g. close an ARC scorecard from the workspace
   * session file). Reconstructible from the workspace, so it is safe on a fresh
   * isolate. The parent supplies the validated tool families it resolved.
   */
  async abortExecution(toolFamilies: string[]): Promise<void> {
    this.ensureTables();
    const ctx = {
      env: this.env,
      workspace: makeWorkspaceHandle(this.workspace()),
      emitProgress: () => {}
    };
    const { abort } = buildRecipeTools(toolFamilies, ctx);
    if (abort) await abort(ctx);
  }

  /** Persist a terminal result to the cache and return it as a done chunk. */
  private cacheTerminal(
    fingerprint: string,
    result: RecipeExecutionResult,
    progress: ProgressEvent[] = []
  ): RecipeChunkResult {
    this.sql`
      INSERT INTO execution_cache (slot, fingerprint, result_json, created_at)
      VALUES (1, ${fingerprint}, ${JSON.stringify(result)}, ${Date.now()})
      ON CONFLICT (slot) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `;
    return { done: true, result, progress };
  }

  /** Persist the rolling run state (called after every model turn). */
  private saveRunState(fingerprint: string, state: ChunkRunState): void {
    this.sql`
      INSERT INTO run_state (slot, fingerprint, state_json, updated_at)
      VALUES (1, ${fingerprint}, ${JSON.stringify(state)}, ${Date.now()})
      ON CONFLICT (slot) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `;
  }
}

/** The cross-RPC stale-child error (see {@link FINGERPRINT_MISMATCH}). */
function mismatch(phase: "terminal" | "in-progress"): Error {
  return new Error(
    `${FINGERPRINT_MISMATCH}: this child already holds a ${phase} state for a ` +
      "different request; the parent must delete a stale child before starting a " +
      "genuinely new execution"
  );
}
