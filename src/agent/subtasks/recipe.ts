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
  "You have no memory of past conversations and no access to any conversation beyond the references provided.",
  "Do not ask follow-up questions; work only from what you are given.",
  "Use your tools when they help, and never fabricate a tool result."
].join("\n");

/**
 * The code-owned default Recipe. Model ids come from {@link file://../../config.ts}
 * so the default always reflects the current configuration — there is no DB seed
 * to go stale. Every Subtask type resolves here until B1 introduces caller-local
 * Recipe rows and type associations.
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
 * Resolve a semantic Subtask type to its Recipe configuration. Code-only for now
 * (always the {@link DEFAULT_RECIPE}); this is the seam B1 extends to consult the
 * caller's `subtask_type_recipes`/`recipes` tables before falling back here.
 */
export function resolveRecipeForType(_type: string): ResolvedRecipe {
  return DEFAULT_RECIPE;
}
