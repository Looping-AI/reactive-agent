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
  SUBAGENT_LIMITS
} from "@/config";

describe("validateRecipe", () => {
  const custom = (overrides: Partial<ResolvedRecipe>): ResolvedRecipe => ({
    ...GENERAL_RECIPE,
    key: "custom",
    ...overrides
  });

  it("resolves the budget but changes nothing else, and never mutates the input", () => {
    const recipe = custom({});
    const before = structuredClone(recipe);
    const validated = validateRecipe(recipe);
    // The one field validation is *supposed* to change: a sparse declaration
    // becomes the budget the runner actually enforces.
    expect(validated).toEqual({ ...before, limits: SUBAGENT_LIMITS });
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

  // The budget merges per field: a Recipe states what it wants to differ and
  // inherits the rest, so `{}` and a full restatement mean the same execution.
  it("merges a partial budget over the baseline", () => {
    const validated = validateRecipe(custom({ limits: { maxTurns: 100 } }));
    expect(validated.limits).toEqual({
      maxTurns: 100,
      maxWallMs: SUBAGENT_LIMITS.maxWallMs
    });
  });

  it("inherits the whole baseline from an empty budget", () => {
    expect(validateRecipe(custom({ limits: {} })).limits).toEqual(
      SUBAGENT_LIMITS
    );
  });

  // Defense-in-depth for a future DB-sourced Recipe: a bad value must degrade to
  // the baseline rather than reach the runner. Per field, so one bad number does
  // not take a good one down with it.
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 2.5]
  ])("falls back to the baseline for a %s maxTurns", (_label, maxTurns) => {
    const validated = validateRecipe(
      custom({ limits: { maxTurns, maxWallMs: 60_000 } })
    );
    expect(validated.limits.maxTurns).toBe(SUBAGENT_LIMITS.maxTurns);
    expect(validated.limits.maxWallMs).toBe(60_000); // the good field survives
  });

  // The wall clock is what actually stops a slow branch, so a Recipe must not be
  // able to disable it by supplying a useless value.
  it("falls back to the baseline for a non-positive maxWallMs", () => {
    const validated = validateRecipe(
      custom({ limits: { maxTurns: 100, maxWallMs: 0 } })
    );
    expect(validated.limits.maxWallMs).toBe(SUBAGENT_LIMITS.maxWallMs);
  });

  // historyWindow has no baseline in config, so the rule flips: config declares a
  // default ⇒ merge; it does not ⇒ require. Substituting one would guess at how
  // much context a domain needs, which is the domain's to know.
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 12.5]
  ])(
    "refuses a %s historyWindow rather than defaulting it",
    (_l, historyWindow) => {
      expect(() => validateRecipe(custom({ historyWindow }))).toThrow(
        RecipeValidationError
      );
      expect(() => validateRecipe(custom({ historyWindow }))).toThrow(
        /historyWindow/
      );
    }
  );
});
