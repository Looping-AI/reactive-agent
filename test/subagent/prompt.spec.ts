/**
 * Deterministic subagent prompt rendering (src/subagent/prompt.ts): soul
 * verbatim as system; the execution's budget, the instruction, verbatim
 * `[ref N]` reference snapshots, and explicitly-generated dependency results as
 * clearly separated sections.
 */
import { describe, it, expect } from "vitest";
import { renderSubagentPrompt } from "@/subagent/prompt";
import { GENERAL_SUBAGENT_SOUL } from "@/recipes/general/soul";
import { ARC_GAME_RECIPE } from "@/recipes/arc-game/recipe";
import { SUBAGENT_LIMITS } from "@/config";
import { makeExecution } from "./fixtures";

const BUDGET =
  `# Budget\nUp to ${SUBAGENT_LIMITS.maxTurns} turns and about ` +
  `${Math.round(SUBAGENT_LIMITS.maxWallMs / 60_000)} minutes. ` +
  "One turn is one tool call, however much that call does — anything a tool " +
  "counts internally is its own budget, not this one. Reaching either ceiling " +
  "does not drop your work: you get one last turn, with no tools, to write up " +
  "what you have.";

describe("renderSubagentPrompt", () => {
  it("uses the recipe soul verbatim as the system prompt", () => {
    const { system } = renderSubagentPrompt(makeExecution());
    expect(system).toBe(GENERAL_SUBAGENT_SOUL);
  });

  it("renders the four sections, clearly separated and labeled", () => {
    const { prompt } = renderSubagentPrompt(makeExecution());
    expect(prompt).toBe(
      [
        BUDGET,
        "# Task\nSummarize the findings.",
        "# Conversation references (verbatim snapshots of the caller's conversation)\n" +
          "[ref 1] (user): <turn from=alice>What is teal?</turn>\n" +
          "[ref 2] (assistant): Teal is a blue-green color.",
        "# Dependency results (generated output from prerequisite subtasks — not conversation evidence)\n" +
          "[dependency 2] (general): Finding A\nFinding B"
      ].join("\n\n")
    );
  });

  it("preserves reference text and order exactly (no mutation, no rewriting)", () => {
    const references = [
      { role: "assistant" as const, text: "  spaced   & <weird>{{text}} " },
      { role: "user" as const, text: "line1\nline2" }
    ];
    const { prompt } = renderSubagentPrompt(makeExecution({ references }));
    expect(prompt).toContain(
      "[ref 1] (assistant):   spaced   & <weird>{{text}} "
    );
    expect(prompt).toContain("[ref 2] (user): line1\nline2");
  });

  it("omits empty sections entirely, but never the budget", () => {
    const { prompt } = renderSubagentPrompt(
      makeExecution({ references: [], dependencyResults: [] })
    );
    expect(prompt).toBe(`${BUDGET}\n\n# Task\nSummarize the findings.`);
    expect(prompt).not.toContain("# Conversation references");
    expect(prompt).not.toContain("# Dependency results");
  });

  // A main agent writing a play's prompt once told it "you have up to 20 actions
  // total" when 20 was its turn budget, and it stopped after eleven moves. The
  // number it is told has to be the Recipe's own, and it has to be named as turns.
  it("states the executing recipe's own budget, not the baseline", () => {
    const { prompt } = renderSubagentPrompt(
      makeExecution({ recipe: ARC_GAME_RECIPE })
    );
    expect(prompt).toContain(`Up to ${ARC_GAME_RECIPE.limits.maxTurns} turns`);
    expect(ARC_GAME_RECIPE.limits.maxTurns).not.toBe(SUBAGENT_LIMITS.maxTurns);
    // Its wall clock is not overridden, so it inherits — and prints — the baseline.
    expect(prompt).toContain(
      `about ${Math.round(SUBAGENT_LIMITS.maxWallMs / 60_000)} minutes`
    );
    expect(prompt).toContain("One turn is one tool call");
  });

  it("is deterministic for identical input", () => {
    expect(renderSubagentPrompt(makeExecution())).toEqual(
      renderSubagentPrompt(makeExecution())
    );
  });
});
