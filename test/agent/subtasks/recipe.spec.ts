/**
 * Unit tests for the code-owned default Recipe (src/agent/subtasks/recipe.ts).
 *
 * The default lives in code, not the DB, so it always reflects config.ts — these
 * tests guard against drift and confirm resolution is code-only for now.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RECIPE,
  STATELESS_SUBAGENT_SOUL,
  resolveRecipeForType
} from "@/agent/subtasks/recipe";
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
