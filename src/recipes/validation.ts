import {
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  DEFAULT_MAX_TURNS,
  DEFAULT_TURNS_PER_CHUNK,
  DEFAULT_CHUNK_SOFT_MS,
  DEFAULT_HISTORY_WINDOW
} from "@/config";
import type { RecipeLimits, ResolvedRecipe } from "./types";

/**
 * The capability boundary every Recipe passes through, whatever declared it.
 *
 * The domains live in sibling folders, each owning its soul and configuration.
 * This module imports none of them — it owns only what code must be able to say
 * about *any* Recipe: which models and tool families it may select, and how a
 * malformed one is made safe or refused. A domain cannot widen its own limits by
 * declaring them, because the check does not come from the declaration.
 */

/**
 * The Workers-AI model ids a Recipe may select — exactly the ids configured in
 * {@link file://../../config.ts}, the only models proven with this tool-loop
 * pipeline. Extend deliberately, one validated model at a time.
 */
export const SUBAGENT_MODEL_ALLOWLIST: ReadonlySet<string> = new Set([
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID
]);

/**
 * The tool-family keys code recognizes for subagent Recipes. `recall` and the
 * Session's `set_context` are never valid families — a subagent has no Session
 * or durable memory to reach — and their absence here makes them structurally
 * impossible to enable through Recipe data.
 */
export const KNOWN_TOOL_FAMILIES: ReadonlySet<string> = new Set([
  "browser",
  "workspace",
  "arc-game"
]);

/**
 * Clamp a Recipe-supplied limit to a positive integer, substituting a code
 * default for a missing, non-integer, or non-positive value. Defense-in-depth for
 * a future DB-sourced Recipe: limits drive the runner's loop bounds, so a bad
 * value must degrade to a safe default rather than spin or stall.
 */
function normalizeLimits(limits: RecipeLimits): RecipeLimits {
  const positiveInt = (n: number, fallback: number): number =>
    Number.isInteger(n) && n > 0 ? n : fallback;
  const maxTurns = positiveInt(limits?.maxTurns, DEFAULT_MAX_TURNS);
  const turnsPerChunk = Math.min(
    positiveInt(limits?.turnsPerChunk, DEFAULT_TURNS_PER_CHUNK),
    maxTurns
  );
  const chunkSoftMs = positiveInt(limits?.chunkSoftMs, DEFAULT_CHUNK_SOFT_MS);
  return { maxTurns, turnsPerChunk, chunkSoftMs };
}

/**
 * Thrown by {@link validateRecipe} for a Recipe that is unusable as given — it is
 * disabled, or it carries no soul. Both are deterministic caller bugs (the parent
 * must only hand enabled, complete Recipes to a subagent), so the child maps this
 * to a terminal failed result rather than retrying.
 */
export class RecipeValidationError extends Error {}

/**
 * Code-owned defensive validation of an already-resolved Recipe. Returns a
 * normalized copy (never mutates the input): a model id outside
 * {@link SUBAGENT_MODEL_ALLOWLIST} is substituted with the config default for its
 * slot — independently per slot — and unknown tool families are dropped (deduped,
 * order-preserving). Applied by the parent when it resolves a Recipe and
 * re-applied by the subagent on its inbound request, so Recipe data can never
 * select arbitrary models or tools.
 *
 * A missing soul is *not* normalized. Substituting a generic one would run the
 * work under an identity nobody declared — the model would answer, plausibly, as
 * something other than what the Recipe is for — so a blank soul fails the Recipe
 * outright. Every Recipe states its own; there is no house default.
 */
export function validateRecipe(recipe: ResolvedRecipe): ResolvedRecipe {
  if (!recipe.enabled) {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) is disabled`
    );
  }
  if (recipe.soul.trim() === "") {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) has no soul`
    );
  }
  const toolFamilies = [...new Set(recipe.toolFamilies)].filter((family) =>
    KNOWN_TOOL_FAMILIES.has(family)
  );
  const historyWindow =
    Number.isInteger(recipe.historyWindow) && recipe.historyWindow > 0
      ? recipe.historyWindow
      : DEFAULT_HISTORY_WINDOW;
  return {
    ...recipe,
    primaryModelId: SUBAGENT_MODEL_ALLOWLIST.has(recipe.primaryModelId)
      ? recipe.primaryModelId
      : CHAT_MODEL_ID,
    fallbackModelId: SUBAGENT_MODEL_ALLOWLIST.has(recipe.fallbackModelId)
      ? recipe.fallbackModelId
      : CHAT_FALLBACK_MODEL_ID,
    toolFamilies,
    limits: normalizeLimits(recipe.limits),
    historyWindow
  };
}
