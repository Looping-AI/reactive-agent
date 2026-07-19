import { DEFAULT_RECIPE } from "@/agent/subtasks/registry";
import type { RecipeExecutionRequest } from "@/agent/subtasks/types";

/**
 * A representative, fully-populated execution request. Override per test; the
 * subagent specs (prompt / fingerprint / run / facet) all build from here so a
 * contract change breaks in one place.
 *
 * This lives here rather than in the shared `test/fixtures.ts` on purpose:
 * `test/fixtures.ts` is statically imported by `vitest.config.ts`, so anything
 * it imports must resolve while Vite bundles the config — before the `@` alias
 * is active. Importing `@/agent/subtasks/registry` from there breaks config load.
 */
export function makeRequest(
  overrides: Partial<RecipeExecutionRequest> = {}
): RecipeExecutionRequest {
  return {
    taskId: "task-1",
    subtaskId: 1,
    recipe: DEFAULT_RECIPE,
    prompt: "Summarize the findings.",
    references: [
      { role: "user", text: "<turn from=alice>What is teal?</turn>" },
      { role: "assistant", text: "Teal is a blue-green color." }
    ],
    dependencyResults: [
      {
        subtaskId: 2,
        type: "research",
        resultParts: [
          { kind: "text", text: "Finding A" },
          { kind: "text", text: "Finding B" }
        ]
      }
    ],
    ...overrides
  };
}
