/**
 * Deterministic request fingerprinting (src/subagent/fingerprint.ts) — the
 * cache key for a subagent's single terminal result.
 */
import { describe, it, expect } from "vitest";
import { fingerprintRequest } from "@/subagent/fingerprint";
import type { RecipeExecutionRequest } from "@/agent/subtasks/types";
import { makeRequest } from "./fixtures";

describe("fingerprintRequest", () => {
  it("is a 64-char hex SHA-256 digest", async () => {
    expect(await fingerprintRequest(makeRequest())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes identical requests identically (fresh objects, same content)", async () => {
    expect(await fingerprintRequest(makeRequest())).toBe(
      await fingerprintRequest(makeRequest())
    );
  });

  it("ignores object key order (canonical field order)", async () => {
    const base = makeRequest();
    const reordered = JSON.parse(
      JSON.stringify({
        dependencyResults: base.dependencyResults,
        references: base.references,
        prompt: base.prompt,
        recipe: base.recipe,
        subtaskId: base.subtaskId,
        taskId: base.taskId
      })
    ) as RecipeExecutionRequest;
    expect(await fingerprintRequest(reordered)).toBe(
      await fingerprintRequest(base)
    );
  });

  it.each<[string, Partial<RecipeExecutionRequest>]>([
    ["taskId", { taskId: "task-2" }],
    ["subtaskId", { subtaskId: 9 }],
    ["prompt", { prompt: "Something else." }],
    [
      "a reference's text",
      {
        references: [
          { role: "user", text: "<turn from=alice>What is cyan?</turn>" },
          { role: "assistant", text: "Teal is a blue-green color." }
        ]
      }
    ],
    ["recipe version", { recipe: { ...makeRequest().recipe, version: 2 } }],
    [
      "a recipe limit",
      {
        recipe: {
          ...makeRequest().recipe,
          limits: { ...makeRequest().recipe.limits, maxTurns: 999 }
        }
      }
    ],
    [
      "the history window",
      { recipe: { ...makeRequest().recipe, historyWindow: 3 } }
    ],
    [
      "a model id",
      { recipe: { ...makeRequest().recipe, primaryModelId: "@cf/other/model" } }
    ],
    [
      "a dependency part",
      {
        dependencyResults: [
          {
            subtaskId: 2,
            type: "research",
            resultParts: [{ kind: "text", text: "Finding A" }]
          }
        ]
      }
    ]
  ])("changes when %s changes", async (_field, overrides) => {
    expect(await fingerprintRequest(makeRequest(overrides))).not.toBe(
      await fingerprintRequest(makeRequest())
    );
  });

  it("distinguishes array order (order is semantic)", async () => {
    const base = makeRequest();
    const swapped = makeRequest({
      references: [...base.references].reverse()
    });
    expect(await fingerprintRequest(swapped)).not.toBe(
      await fingerprintRequest(base)
    );
  });
});
