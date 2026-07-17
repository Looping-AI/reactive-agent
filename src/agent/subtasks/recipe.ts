import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import type { ResolvedRecipe } from "./types";

/**
 * The stateless subagent soul — the frozen identity for a managed Subtask
 * subagent. Distinct from the main-agent {@link file://./prompt.ts SOUL}: a
 * subagent has no Session, no durable memory, no recall, and no access to parent
 * history beyond the references supplied inline on its Subtask.
 */
export const STATELESS_SUBAGENT_SOUL = [
  "You are a stateless execution subagent. You are given a single, self-contained task with all necessary context supplied inline.",
  "Complete exactly that task and return a concise, direct result.",
  "Your result is raw material, not a reply: a parent agent composes it — often with other subagents' results — into the single answer the user actually sees. You are never speaking to the user. Return only the substance: no greeting, no preamble, no restating the task, no sign-off.",
  "You have no memory of past conversations and no access to any conversation beyond the references provided.",
  "Do not ask follow-up questions; work only from what you are given.",
  "Use your tools when they help, and never fabricate a tool result."
].join("\n");

/**
 * The code-owned default Recipe. Model ids come from {@link file://../../config.ts}
 * so the default always reflects the current configuration — there is no DB seed
 * to go stale. Every Subtask type resolves here until a future Recipe admin
 * phase introduces caller-local Recipe rows and type associations.
 */
export const DEFAULT_RECIPE: ResolvedRecipe = {
  key: "default",
  version: 1,
  primaryModelId: CHAT_MODEL_ID,
  fallbackModelId: CHAT_FALLBACK_MODEL_ID,
  soul: STATELESS_SUBAGENT_SOUL,
  toolFamilies: ["browser"],
  enabled: true
};

/**
 * Resolve a semantic Subtask type to its Recipe configuration. Code-only
 * (always the {@link DEFAULT_RECIPE}); this is the seam a future Recipe admin
 * phase extends to consult caller-local `subtask_type_recipes`/`recipes` tables
 * before falling back here.
 */
export function resolveRecipeForType(_type: string): ResolvedRecipe {
  return DEFAULT_RECIPE;
}

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
export const KNOWN_TOOL_FAMILIES: ReadonlySet<string> = new Set(["browser"]);

/**
 * Thrown by {@link validateRecipe} for a disabled Recipe — a deterministic
 * caller bug (the parent must only hand enabled Recipes to a subagent), so the
 * child maps it to a terminal failed result rather than retrying.
 */
export class RecipeValidationError extends Error {}

/**
 * Code-owned defensive validation of an already-resolved Recipe. Returns a
 * normalized copy (never mutates the input): a model id outside
 * {@link SUBAGENT_MODEL_ALLOWLIST} is substituted with the config default for
 * its slot — independently per slot — unknown tool families are dropped
 * (deduped, order-preserving), and a blank soul falls back to
 * {@link STATELESS_SUBAGENT_SOUL}. Applied by the parent when it resolves a
 * Recipe and re-applied by the subagent on its inbound request, so Recipe data
 * can never select arbitrary models or tools.
 */
export function validateRecipe(recipe: ResolvedRecipe): ResolvedRecipe {
  if (!recipe.enabled) {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) is disabled`
    );
  }
  const soul =
    recipe.soul.trim() === "" ? STATELESS_SUBAGENT_SOUL : recipe.soul;
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
    soul,
    toolFamilies
  };
}
