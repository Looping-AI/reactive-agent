/**
 * Unit tests for the code-owned general Recipe (src/recipes/general/recipe.ts).
 *
 * It lives in code, not the DB, so it always reflects config.ts — these tests
 * guard against drift.
 */
import { describe, it, expect } from "vitest";
import { GENERAL_RECIPE, GENERAL_TYPE } from "@/recipes/general/recipe";
import { GENERAL_SUBAGENT_SOUL } from "@/recipes/general/soul";
import { validateRecipe } from "@/recipes/validation";
import {
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  SUBAGENT_LIMITS
} from "@/config";

describe("GENERAL_RECIPE", () => {
  it("mirrors the config model ids (no stale DB seed)", () => {
    expect(GENERAL_RECIPE.primaryModelId).toBe(CHAT_MODEL_ID);
    expect(GENERAL_RECIPE.fallbackModelId).toBe(CHAT_FALLBACK_MODEL_ID);
  });

  it("is the enabled 'general' recipe with the browser tool family", () => {
    expect(GENERAL_RECIPE.key).toBe(GENERAL_TYPE);
    expect(GENERAL_RECIPE.version).toBe(1);
    expect(GENERAL_RECIPE.enabled).toBe(true);
    expect(GENERAL_RECIPE.toolFamilies).toEqual(["browser"]);
    expect(GENERAL_RECIPE.soul).toBe(GENERAL_SUBAGENT_SOUL);
  });

  it("overrides no budget, so it runs on the baseline", () => {
    // Work with no domain of its own has no reason to want a different budget —
    // and `{}` is what makes that a stated position rather than a stale copy.
    expect(GENERAL_RECIPE.limits).toEqual({});
    expect(validateRecipe(GENERAL_RECIPE).limits).toEqual(SUBAGENT_LIMITS);
  });

  it("keeps enough context that a full-budget run never prunes, and reports no metrics", () => {
    expect(GENERAL_RECIPE.historyWindow).toBeGreaterThanOrEqual(
      SUBAGENT_LIMITS.maxTurns
    );
    expect(GENERAL_RECIPE.reportMetrics).toBe(false);
  });
});
