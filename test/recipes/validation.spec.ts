/**
 * Unit tests for the Recipe capability boundary (src/recipes/validation.ts):
 * the models and tool families any Recipe may select, and how a malformed one is
 * made safe. The Recipes themselves live under `src/recipes/` and are tested
 * there.
 */
import { describe, it, expect } from "vitest";
import { RecipeValidationError, validateRecipe } from "@/recipes/validation";
import { GENERAL_RECIPE } from "@/recipes/general/recipe";
import type { ResolvedRecipe } from "@/recipes/types";
import {
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  DEFAULT_MAX_TURNS
} from "@/config";

describe("validateRecipe", () => {
  const custom = (overrides: Partial<ResolvedRecipe>): ResolvedRecipe => ({
    ...GENERAL_RECIPE,
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

  it("rejects a blank soul rather than substituting a generic one", () => {
    // A Recipe must declare its own identity: running the work under a soul
    // nobody chose would answer plausibly as something other than the Recipe.
    expect(() => validateRecipe(custom({ soul: "   \n " }))).toThrow(
      RecipeValidationError
    );
    expect(() => validateRecipe(custom({ soul: "" }))).toThrow(/has no soul/);
  });

  it("passes a present soul through verbatim, whitespace and all", () => {
    // The soul becomes the system prompt unmodified; validation only decides
    // whether there is one.
    expect(validateRecipe(custom({ soul: "  Be brief.\n" })).soul).toBe(
      "  Be brief.\n"
    );
  });

  it("throws RecipeValidationError for a disabled recipe", () => {
    expect(() => validateRecipe(custom({ enabled: false }))).toThrow(
      RecipeValidationError
    );
  });

  it("clamps turnsPerChunk to maxTurns and substitutes non-positive limits", () => {
    const validated = validateRecipe(
      custom({
        limits: { maxTurns: 100, turnsPerChunk: 250, chunkSoftMs: -5 }
      })
    );
    expect(validated.limits.maxTurns).toBe(100);
    expect(validated.limits.turnsPerChunk).toBe(100); // clamped down to maxTurns
    expect(validated.limits.chunkSoftMs).toBeGreaterThan(0); // substituted default
  });

  it("substitutes a code default for a non-integer maxTurns", () => {
    const validated = validateRecipe(
      custom({ limits: { maxTurns: 0, turnsPerChunk: 4, chunkSoftMs: 1000 } })
    );
    expect(validated.limits.maxTurns).toBe(DEFAULT_MAX_TURNS);
    // turnsPerChunk (4) is still <= the substituted default, so it survives.
    expect(validated.limits.turnsPerChunk).toBe(4);
  });

  it("substitutes a code default for a non-positive historyWindow", () => {
    expect(
      validateRecipe(custom({ historyWindow: 0 })).historyWindow
    ).toBeGreaterThan(0);
  });
});
