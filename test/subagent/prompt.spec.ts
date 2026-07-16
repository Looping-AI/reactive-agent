/**
 * Deterministic subagent prompt rendering (src/subagent/prompt.ts): soul
 * verbatim as system; instruction, verbatim `[ref N]` reference snapshots, and
 * explicitly-generated dependency results as clearly separated sections.
 */
import { describe, it, expect } from "vitest";
import { renderSubagentPrompt } from "@/subagent/prompt";
import { STATELESS_SUBAGENT_SOUL } from "@/agent/subtasks/recipe";
import { makeRequest } from "./fixtures";

describe("renderSubagentPrompt", () => {
  it("uses the recipe soul verbatim as the system prompt", () => {
    const { system } = renderSubagentPrompt(makeRequest());
    expect(system).toBe(STATELESS_SUBAGENT_SOUL);
  });

  it("renders the three sections, clearly separated and labeled", () => {
    const { prompt } = renderSubagentPrompt(makeRequest());
    expect(prompt).toBe(
      [
        "# Task\nSummarize the findings.",
        "# Conversation references (verbatim snapshots of the caller's conversation)\n" +
          "[ref 1] (user): <turn from=alice>What is teal?</turn>\n" +
          "[ref 2] (assistant): Teal is a blue-green color.",
        "# Dependency results (generated output from prerequisite subtasks — not conversation evidence)\n" +
          "[dependency 2] (research): Finding A\nFinding B"
      ].join("\n\n")
    );
  });

  it("preserves reference text and order exactly (no mutation, no rewriting)", () => {
    const references = [
      { role: "assistant" as const, text: "  spaced   & <weird>{{text}} " },
      { role: "user" as const, text: "line1\nline2" }
    ];
    const { prompt } = renderSubagentPrompt(makeRequest({ references }));
    expect(prompt).toContain(
      "[ref 1] (assistant):   spaced   & <weird>{{text}} "
    );
    expect(prompt).toContain("[ref 2] (user): line1\nline2");
  });

  it("omits empty sections entirely", () => {
    const { prompt } = renderSubagentPrompt(
      makeRequest({ references: [], dependencyResults: [] })
    );
    expect(prompt).toBe("# Task\nSummarize the findings.");
    expect(prompt).not.toContain("# Conversation references");
    expect(prompt).not.toContain("# Dependency results");
  });

  it("is deterministic for identical input", () => {
    expect(renderSubagentPrompt(makeRequest())).toEqual(
      renderSubagentPrompt(makeRequest())
    );
  });
});
