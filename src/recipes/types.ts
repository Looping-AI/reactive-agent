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
 * A type's param declaration, as a shape the agent can read back — not an opaque
 * validator. The keys have to be *enumerable* because the delegate tool's schema
 * is built from them: a param the model cannot see declared is a param it will
 * not send. See {@link SubtaskTypeSpec.params}.
 */
export type SubtaskParamsShape = Record<string, z.ZodType<string>>;
export type SubtaskParamsSchema = z.ZodObject<SubtaskParamsShape>;

/**
 * The execution budget for one Recipe, enforced by the resumable runner (not the
 * Workflow). Exactly two fields, because there are exactly two things worth
 * bounding: what an execution **costs** and how long it can **run away for**. The
 * run ends on whichever it reaches first, and either way through the graceful
 * budget summary.
 *
 * Deliberately *not* here: how a run is sliced into durable chunks. That is a
 * Workers step-timeout constraint, it is identical for every Recipe, and it lives
 * in {@link file://../platform.ts}. It used to include a `turnsPerChunk`, on the
 * theory that a turn count could keep a step under the timeout — it cannot,
 * because nothing predicts how long a turn takes, and the resulting arithmetic was
 * wrong by 2-3× in practice.
 */
export interface RecipeLimits {
  /** Whole-execution ceiling on model turns (one turn = one tool-loop step). */
  maxTurns: number;
  /**
   * Whole-execution wall-clock ceiling (ms), measured from the first chunk and
   * carried across chunks in the run checkpoint. For any recipe whose turns are
   * slow it, not `maxTurns`, is what actually ends the execution.
   */
  maxWallMs: number;
}

/**
 * A Recipe configuration as a domain **declares** it, one per folder in
 * `recipes/<domain>/recipe.ts`; caller-local DB rows mapping into this shape are
 * deferred until a Recipe admin surface exists. Model ids, tool families, and
 * limits are code-validated downstream
 * ({@link file://./validation.ts validateRecipe}), which is also what turns this
 * into a {@link ValidatedRecipe}.
 *
 * One rule governs every field here, and it is worth stating once: **if
 * `config.ts` declares a baseline, a Recipe overrides it; if it does not, the
 * Recipe must supply it.** So `limits` is partial and merges, while `soul` and
 * `historyWindow` are required and a missing one is refused rather than filled in.
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
  /**
   * Only the budget fields this Recipe overrides; the rest come from
   * `SUBAGENT_LIMITS`. `{}` means "the baseline", which is what most Recipes want.
   */
  limits: Partial<RecipeLimits>;
  /**
   * Most-recent turns kept verbatim in the rolling model context; older turns are
   * pruned. Required, and required *of the Recipe*: how much context a domain
   * needs is a property of the domain, so there is no house default to fall back
   * to and a missing one is a refused Recipe.
   */
  historyWindow: number;
  /** Append a runtime metrics footer (turns, model calls, wall-clock) to the final result. */
  reportMetrics: boolean;
}

/**
 * A Recipe that has been through {@link file://./validation.ts validateRecipe} —
 * limits merged over the baseline, models and tool families checked. The only
 * shape the runner ever consumes: a `Partial<RecipeLimits>` can never reach it.
 */
export interface ValidatedRecipe extends ResolvedRecipe {
  limits: RecipeLimits;
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
   *
   * A `z.object`, not an opaque `z.ZodType`, and that is load-bearing: the agent
   * reads `.shape` back to build the `params` field of the delegate tool's schema
   * (see `subtaskParamProperties`). Declaring a param the model is never shown is
   * the failure this shape exists to prevent — describe each key with
   * `.describe()`, because that text is what the model reads.
   */
  params: SubtaskParamsSchema | null;
  /** How the model is told to obtain each param, appended to the description. */
  paramsHelp?: string;
  /** The execution configuration this type runs under. */
  recipe: ResolvedRecipe;
}
