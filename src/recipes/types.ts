import type { z } from "zod";

/**
 * What a recipe domain declares. These types are owned by `src/recipes/` and
 * flow *outward*: the agent consumes them, and nothing here imports from
 * `agent/`. That direction is what lets a new domain be a new folder plus one
 * line in {@link file://./index.ts}, with no edit inside `agent/`.
 *
 * Two shapes, and the distinction between them carries real weight:
 *
 * - A **type** ({@link SubtaskTypeSpec}) is the semantic contract of a unit of
 *   work: what it means, and what it must be given to be doable at all.
 * - A **Recipe** ({@link ResolvedRecipe}) is the execution *configuration* —
 *   models, soul, tool families, budgets. It declares no params, and one Recipe
 *   may serve several types.
 */

/** Params carried by a Subtask: model-chosen, string-valued, shape-checked. */
export type SubtaskParams = Record<string, string>;

/**
 * Execution budget for one Recipe, enforced by the resumable runner (not the
 * Workflow). The runner drives the model/tool loop in durable **chunks**: it runs
 * up to `turnsPerChunk` turns (or `chunkSoftMs` wall-clock, whichever first) per
 * Workflow step, checkpoints, and yields for a fresh step — so a long run never
 * exceeds the platform's per-step timeout. `maxTurns` is the whole-execution
 * ceiling across every chunk. The general recipe sets `maxTurns === turnsPerChunk`
 * so it always finishes in one chunk.
 */
export interface RecipeLimits {
  /** Whole-execution ceiling on model turns (one turn = one tool-loop step). */
  maxTurns: number;
  /** Turns to run within a single durable chunk before yielding a fresh step. */
  turnsPerChunk: number;
  /** Soft wall-clock budget (ms) per chunk; ends a chunk early to stay under the step timeout. */
  chunkSoftMs: number;
}

/**
 * A fully-resolved Recipe configuration handed to a subagent invocation. Today
 * these are code-owned constants, one per domain in `recipes/<domain>/recipe.ts`;
 * caller-local DB rows mapping into this shape are deferred until a Recipe admin
 * surface exists. Model ids, tool families, and limits remain code-validated
 * downstream ({@link file://./validation.ts validateRecipe}).
 */
export interface ResolvedRecipe {
  key: string;
  version: number;
  primaryModelId: string;
  fallbackModelId: string;
  /** Required, never defaulted — see `validateRecipe`. */
  soul: string;
  toolFamilies: string[];
  enabled: boolean;
  /** Turn/chunk/time budget the resumable runner enforces. */
  limits: RecipeLimits;
  /** Most-recent turns kept verbatim in the rolling model context; older turns are pruned. */
  historyWindow: number;
  /** Append a runtime metrics footer (turns, model calls, wall-clock) to the final result. */
  reportMetrics: boolean;
}

/**
 * One entry in the closed set of Subtask types the main agent may delegate,
 * declared by the domain that owns it and collected in
 * {@link file://./index.ts}.
 *
 * Two things follow from the set being closed rather than free prose:
 *
 * - The delegating model picks from an enum, so an invented type is rejected by
 *   the tool schema itself instead of silently falling back to a general recipe.
 * - A type can *require params*. `arc-game` cannot be attempted without a
 *   scorecard and a game, so a subtask that names neither is refused up front
 *   rather than discovering it has nothing to play several turns later.
 *
 * Params are the model's declared inputs — ids it chose, validated for shape and
 * resolved against durable rows at execution start. They are never the place for
 * anything the model cannot know: an API session pinned to one of those ids is
 * resolved by the parent from the id, never carried in the params.
 */
export interface SubtaskTypeSpec {
  key: string;
  /** One line shown to the delegating model so it picks the right type. */
  description: string;
  /**
   * Required params for this type, or null when it takes none. Kept to flat
   * strings: these are ids the model quotes from a tool result, not structures.
   */
  params: z.ZodType<SubtaskParams> | null;
  /** How the model is told to obtain each param, appended to the description. */
  paramsHelp?: string;
  /** The execution configuration this type runs under. */
  recipe: ResolvedRecipe;
}
