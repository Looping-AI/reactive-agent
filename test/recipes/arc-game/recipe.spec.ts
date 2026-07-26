/**
 * Unit tests for the ARC-AGI-3 Recipe (src/recipes/arc-game/recipe.ts) — the
 * long, resumable counterpart to the general recipe.
 */
import { describe, it, expect } from "vitest";
import { resolveRecipeForType } from "@/agent/subtasks/subtask-types";
import { ARC_GAME_TYPE } from "@/recipes/arc-game/recipe";
import { MAX_CHUNKS_PER_BRANCH } from "@/config";

describe("ARC_GAME_RECIPE", () => {
  it("is a long-running recipe with the workspace and arc-game tool families", () => {
    const recipe = resolveRecipeForType(ARC_GAME_TYPE);
    expect(recipe.key).toBe(ARC_GAME_TYPE);
    // A long recipe: many turns spanning multiple chunks, and it reports metrics.
    expect(recipe.limits.maxTurns).toBeGreaterThan(recipe.limits.turnsPerChunk);
    expect(recipe.reportMetrics).toBe(true);
    expect(recipe.toolFamilies).toEqual(["workspace", "arc-game"]);
  });

  it("keeps the longest recipe inside the Workflow's per-branch chunk cap", () => {
    // `MAX_CHUNKS_PER_BRANCH` is what stops a branch approaching the Workflows
    // per-instance step ceiling, and the Workflow *fails* a branch that hits it.
    // So a recipe's nominal chunk count must stay well under the cap — with room
    // for the progress events that end a chunk early. Raising `maxTurns` without
    // raising the cap would silently start killing long games mid-run.
    const { maxTurns, turnsPerChunk } =
      resolveRecipeForType(ARC_GAME_TYPE).limits;
    const nominalChunks = Math.ceil(maxTurns / turnsPerChunk);
    expect(nominalChunks).toBeLessThanOrEqual(MAX_CHUNKS_PER_BRANCH / 2);
  });
});
