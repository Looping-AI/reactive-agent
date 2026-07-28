import {
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  SUBAGENT_LIMITS
} from "@/config";
import type { RecipeLimits, ResolvedRecipe, ValidatedRecipe } from "./types";

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
 * Merge a Recipe's declared budget over {@link SUBAGENT_LIMITS}, per field. A
 * positive integer wins; anything else — missing, null, zero, fractional — falls
 * back to the baseline rather than reaching the runner.
 *
 * Defense-in-depth for a future DB-sourced Recipe, and the reason a Recipe cannot
 * widen its own limits: the baseline does not come from the declaration.
 *
 * Exported separately from {@link validateRecipe} because it must never throw.
 * The execution fingerprint is computed *before* a Recipe is validated — that
 * ordering is what lets a disabled or malformed Recipe become a cached terminal
 * failure instead of an exception — so the fingerprint needs the merge alone.
 */
export function resolveLimits(limits: Partial<RecipeLimits>): RecipeLimits {
  const positiveInt = (n: number | undefined, fallback: number): number =>
    typeof n === "number" && Number.isInteger(n) && n > 0 ? n : fallback;
  return {
    maxTurns: positiveInt(limits?.maxTurns, SUBAGENT_LIMITS.maxTurns),
    maxWallMs: positiveInt(limits?.maxWallMs, SUBAGENT_LIMITS.maxWallMs)
  };
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
 * The split between what is normalized and what is refused follows one rule:
 * **`config.ts` declares a baseline ⇒ merge; it does not ⇒ require.** `limits`
 * merge. A soul and a `historyWindow` do not: substituting a generic soul would
 * run the work under an identity nobody declared — the model would answer,
 * plausibly, as something other than what the Recipe is for — and how much context
 * a domain needs is likewise a property of the domain, not something a house
 * default can guess. Both fail the Recipe outright.
 */
export function validateRecipe(recipe: ResolvedRecipe): ValidatedRecipe {
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
  if (!Number.isInteger(recipe.historyWindow) || recipe.historyWindow <= 0) {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) has no usable historyWindow ` +
        `(got ${recipe.historyWindow}); every recipe states its own`
    );
  }
  const toolFamilies = [...new Set(recipe.toolFamilies)].filter((family) =>
    KNOWN_TOOL_FAMILIES.has(family)
  );
  return {
    ...recipe,
    primaryModelId: SUBAGENT_MODEL_ALLOWLIST.has(recipe.primaryModelId)
      ? recipe.primaryModelId
      : CHAT_MODEL_ID,
    fallbackModelId: SUBAGENT_MODEL_ALLOWLIST.has(recipe.fallbackModelId)
      ? recipe.fallbackModelId
      : CHAT_FALLBACK_MODEL_ID,
    toolFamilies,
    limits: resolveLimits(recipe.limits)
  };
}
