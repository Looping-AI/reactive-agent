/**
 * Unit tests for the reference-catalog eligibility rule
 * (src/agent/subtasks/catalog.ts). Pure over plain SessionMessages — no Session,
 * no DB. What the rule *produces* (the `[ref N]` markers and the catalog they
 * index) is covered in test/agent/turn.spec.ts, which walks the same predicate.
 */
import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import { isCatalogEligible } from "@/agent/subtasks/catalog";

const msg = (
  role: string,
  text: string,
  id = crypto.randomUUID()
): SessionMessage => ({
  id,
  role,
  createdAt: new Date(),
  parts: [{ type: "text", text }]
});

describe("isCatalogEligible", () => {
  it("accepts verbatim user and assistant turns", () => {
    expect(isCatalogEligible(msg("user", "<turn>first</turn>"))).toBe(true);
    expect(isCatalogEligible(msg("assistant", "reply one"))).toBe(true);
  });

  it("excludes compaction summaries (compaction_ id prefix)", () => {
    // Generated text, never original conversation evidence — readable as
    // context, structurally uncitable as a reference.
    const summary = msg(
      "assistant",
      "a summary of older history",
      "compaction_abc123"
    );
    expect(isCatalogEligible(summary)).toBe(false);
  });

  it("excludes non-user/assistant roles", () => {
    expect(isCatalogEligible(msg("system", "you are a bot"))).toBe(false);
    expect(isCatalogEligible(msg("tool", "some tool output"))).toBe(false);
  });

  it("excludes whitespace-only turns", () => {
    expect(isCatalogEligible(msg("assistant", "   \n  "))).toBe(false);
    expect(isCatalogEligible(msg("user", ""))).toBe(false);
  });

  it("reads across multiple text parts, ignoring non-text ones", () => {
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      createdAt: new Date(),
      parts: [
        { type: "reasoning", reasoning: "thinking..." },
        { type: "text", text: "final " },
        { type: "text", text: "answer" }
      ]
    };
    expect(isCatalogEligible(message)).toBe(true);
  });

  it("excludes a message whose only content is a non-text part", () => {
    const message: SessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      createdAt: new Date(),
      parts: [{ type: "reasoning", reasoning: "thinking..." }]
    };
    expect(isCatalogEligible(message)).toBe(false);
  });
});
