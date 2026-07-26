import type { RecipeExecutionRequest } from "@/agent/subtasks/types";
import type { ResolvedRecipe } from "@/recipes/types";

/**
 * Canonical JSON of the fields that define an execution's identity, rebuilt as
 * literals in fixed key order so `JSON.stringify` is deterministic (object
 * insertion order). Array order is semantic and preserved: the parent builds
 * references and dependency results from ordinal-ordered rows, so a retry of
 * the same execution is byte-identical.
 */
export function canonicalRequest(request: RecipeExecutionRequest): string {
  const recipe: ResolvedRecipe = {
    key: request.recipe.key,
    version: request.recipe.version,
    primaryModelId: request.recipe.primaryModelId,
    fallbackModelId: request.recipe.fallbackModelId,
    soul: request.recipe.soul,
    toolFamilies: request.recipe.toolFamilies,
    enabled: request.recipe.enabled,
    limits: {
      maxTurns: request.recipe.limits.maxTurns,
      turnsPerChunk: request.recipe.limits.turnsPerChunk,
      chunkSoftMs: request.recipe.limits.chunkSoftMs
    },
    historyWindow: request.recipe.historyWindow,
    reportMetrics: request.recipe.reportMetrics
  };
  const canonical: RecipeExecutionRequest = {
    taskId: request.taskId,
    subtaskId: request.subtaskId,
    type: request.type,
    recipe,
    prompt: request.prompt,
    references: request.references.map((ref) => ({
      role: ref.role,
      text: ref.text
    })),
    dependencyResults: request.dependencyResults.map((dep) => ({
      subtaskId: dep.subtaskId,
      type: dep.type,
      resultParts: dep.resultParts.map((part) => ({
        kind: part.kind,
        text: part.text
      }))
    })),
    // Params ARE identity: the same prompt against a different scorecard is
    // different work, and must not replay a cached result. Key order is fixed by
    // sorting, so an equivalent params object always canonicalizes identically.
    params: Object.fromEntries(
      Object.entries(request.params).sort(([a], [b]) => (a < b ? -1 : 1))
    )
  };
  return JSON.stringify(canonical);
}

/**
 * SHA-256 hex digest of the canonical request — the deterministic key for the
 * subagent's single cached terminal result. The raw (pre-validation) request is
 * fingerprinted, so the key matches exactly what the parent re-sends on retry.
 */
export async function fingerprintRequest(
  request: RecipeExecutionRequest
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRequest(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
