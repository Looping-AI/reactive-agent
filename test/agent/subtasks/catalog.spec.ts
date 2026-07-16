/**
 * Unit tests for the ephemeral decomposition-time reference catalog
 * (src/agent/subtasks/catalog.ts). Pure over plain SessionMessage arrays — no
 * Session, no DB.
 */
import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import { buildReferenceCatalog } from "@/agent/subtasks/catalog";

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

describe("buildReferenceCatalog", () => {
  it("numbers eligible user/assistant turns 1..N in history order", () => {
    const catalog = buildReferenceCatalog([
      msg("user", "<turn>first</turn>"),
      msg("assistant", "reply one"),
      msg("user", "<turn>second</turn>")
    ]);

    expect(catalog).toEqual([
      { index: 1, role: "user", text: "<turn>first</turn>" },
      { index: 2, role: "assistant", text: "reply one" },
      { index: 3, role: "user", text: "<turn>second</turn>" }
    ]);
  });

  it("excludes compaction summaries (compaction_ id prefix)", () => {
    const catalog = buildReferenceCatalog([
      msg("user", "kept"),
      msg("assistant", "a summary of older history", "compaction_abc123"),
      msg("assistant", "also kept")
    ]);

    expect(catalog.map((e) => e.text)).toEqual(["kept", "also kept"]);
    // Re-numbered contiguously with the summary removed.
    expect(catalog.map((e) => e.index)).toEqual([1, 2]);
  });

  it("excludes non-user/assistant roles", () => {
    const catalog = buildReferenceCatalog([
      msg("system", "you are a bot"),
      msg("user", "hi"),
      msg("tool", "some tool output")
    ]);

    expect(catalog).toEqual([{ index: 1, role: "user", text: "hi" }]);
  });

  it("skips whitespace-only turns", () => {
    const catalog = buildReferenceCatalog([
      msg("user", "real"),
      msg("assistant", "   \n  "),
      msg("user", "also real")
    ]);

    expect(catalog.map((e) => e.text)).toEqual(["real", "also real"]);
    expect(catalog.map((e) => e.index)).toEqual([1, 2]);
  });

  it("concatenates multiple text parts and ignores non-text parts", () => {
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

    const catalog = buildReferenceCatalog([message]);
    expect(catalog).toEqual([
      { index: 1, role: "assistant", text: "final answer" }
    ]);
  });

  it("returns an empty catalog for empty history", () => {
    expect(buildReferenceCatalog([])).toEqual([]);
  });
});
