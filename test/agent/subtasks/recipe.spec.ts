/**
 * Unit tests for the code-owned default Recipe (src/agent/subtasks/recipe.ts).
 *
 * The default lives in code, not the DB, so it always reflects config.ts — these
 * tests guard against drift and confirm resolution is code-only for now.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECIPE,
  RecipeValidationError,
  STATELESS_SUBAGENT_SOUL,
  resolveRecipeForType,
  validateRecipe
} from "@/agent/subtasks/recipe";
import type { ResolvedRecipe } from "@/agent/subtasks/types";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";

describe("DEFAULT_RECIPE", () => {
  it("mirrors the config model ids (no stale DB seed)", () => {
    expect(DEFAULT_RECIPE.primaryModelId).toBe(CHAT_MODEL_ID);
    expect(DEFAULT_RECIPE.fallbackModelId).toBe(CHAT_FALLBACK_MODEL_ID);
  });

  it("is the enabled 'default' recipe with the browser tool family", () => {
    expect(DEFAULT_RECIPE.key).toBe("default");
    expect(DEFAULT_RECIPE.version).toBe(1);
    expect(DEFAULT_RECIPE.enabled).toBe(true);
    expect(DEFAULT_RECIPE.toolFamilies).toEqual(["browser"]);
    expect(DEFAULT_RECIPE.soul).toBe(STATELESS_SUBAGENT_SOUL);
  });
});

describe("resolveRecipeForType", () => {
  it("returns the code default for any semantic type (code-only for now)", () => {
    expect(resolveRecipeForType("general")).toBe(DEFAULT_RECIPE);
    expect(resolveRecipeForType("research")).toBe(DEFAULT_RECIPE);
  });
});

describe("validateRecipe", () => {
  const custom = (overrides: Partial<ResolvedRecipe>): ResolvedRecipe => ({
    ...DEFAULT_RECIPE,
    key: "custom",
    ...overrides
  });

  it("passes a valid recipe through unchanged without mutating the input", () => {
    const recipe = custom({});
    const before = structuredClone(recipe);
    expect(validateRecipe(recipe)).toEqual(before);
    expect(recipe).toEqual(before);
  });

  it("substitutes a non-allowlisted primary id, keeping a valid fallback", () => {
    const validated = validateRecipe(custom({ primaryModelId: "@cf/evil/x" }));
    expect(validated.primaryModelId).toBe(CHAT_MODEL_ID);
    expect(validated.fallbackModelId).toBe(CHAT_FALLBACK_MODEL_ID);
  });

  it("substitutes a non-allowlisted fallback id, keeping a valid primary", () => {
    const validated = validateRecipe(custom({ fallbackModelId: "@cf/evil/x" }));
    expect(validated.primaryModelId).toBe(CHAT_MODEL_ID);
    expect(validated.fallbackModelId).toBe(CHAT_FALLBACK_MODEL_ID);
  });

  it("keeps swapped-but-allowlisted model ids (membership, not slot, is checked)", () => {
    const validated = validateRecipe(
      custom({
        primaryModelId: CHAT_FALLBACK_MODEL_ID,
        fallbackModelId: CHAT_MODEL_ID
      })
    );
    expect(validated.primaryModelId).toBe(CHAT_FALLBACK_MODEL_ID);
    expect(validated.fallbackModelId).toBe(CHAT_MODEL_ID);
  });

  it("drops unknown tool families — recall/set_context can never be smuggled in", () => {
    const validated = validateRecipe(
      custom({ toolFamilies: ["recall", "browser", "set_context", "warp"] })
    );
    expect(validated.toolFamilies).toEqual(["browser"]);
  });

  it("dedupes tool families preserving first-seen order", () => {
    const validated = validateRecipe(
      custom({ toolFamilies: ["browser", "browser"] })
    );
    expect(validated.toolFamilies).toEqual(["browser"]);
  });

  it("substitutes the stateless soul for a blank soul", () => {
    const validated = validateRecipe(custom({ soul: "   \n " }));
    expect(validated.soul).toBe(STATELESS_SUBAGENT_SOUL);
  });

  it("throws RecipeValidationError for a disabled recipe", () => {
    expect(() => validateRecipe(custom({ enabled: false }))).toThrow(
      RecipeValidationError
    );
  });
});
