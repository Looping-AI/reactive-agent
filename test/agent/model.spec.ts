/**
 * `createModelPair` id parameterization (src/agent/model.ts): the pair reports
 * per-recipe ids while instance overrides still control the model objects. No
 * allowlisting happens here — `validateRecipe` is the single validation owner.
 */
import { describe, it, expect } from "vitest";
import { createModelPair } from "@/agent/model";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import { mockModel } from "./mock-model";

describe("createModelPair", () => {
  it("defaults to the config ids", () => {
    const pair = createModelPair();
    expect(pair.primaryId()).toBe(CHAT_MODEL_ID);
    expect(pair.fallbackId()).toBe(CHAT_FALLBACK_MODEL_ID);
  });

  it("reports per-recipe ids when parameterized", () => {
    const pair = createModelPair({
      primaryModelId: CHAT_FALLBACK_MODEL_ID,
      fallbackModelId: CHAT_MODEL_ID
    });
    expect(pair.primaryId()).toBe(CHAT_FALLBACK_MODEL_ID);
    expect(pair.fallbackId()).toBe(CHAT_MODEL_ID);
  });

  it("lets instance overrides control the model objects independently of ids", () => {
    const primary = mockModel({ text: "p" });
    const fallback = mockModel({ text: "f" });
    const pair = createModelPair({
      model: primary,
      fallbackModel: fallback,
      primaryModelId: "@cf/some/custom"
    });
    expect(pair.primary()).toBe(primary);
    expect(pair.fallback()).toBe(fallback);
    expect(pair.primaryId()).toBe("@cf/some/custom");
  });

  it("falls back to the primary override when no fallback override is given", () => {
    const primary = mockModel({ text: "p" });
    const pair = createModelPair({ model: primary });
    expect(pair.fallback()).toBe(primary);
  });
});
