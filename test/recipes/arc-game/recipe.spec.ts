/**
 * Unit tests for the ARC-AGI-3 Recipe (src/recipes/arc-game/recipe.ts).
 */
import { describe, it, expect } from "vitest";
import { resolveRecipeForType } from "@/agent/subtasks/subtask-types";
import {
  ARC_GAME_RECIPE,
  ARC_GAME_SPEC,
  ARC_GAME_TYPE
} from "@/recipes/arc-game/recipe";
import { validateRecipe } from "@/recipes/validation";
import { SUBAGENT_LIMITS } from "@/config";

describe("ARC_GAME_RECIPE", () => {
  it("is the enabled arc-game recipe with the workspace and arc-game tool families", () => {
    const recipe = resolveRecipeForType(ARC_GAME_TYPE);
    expect(recipe.key).toBe(ARC_GAME_TYPE);
    expect(recipe.reportMetrics).toBe(true);
    expect(recipe.toolFamilies).toEqual(["workspace", "arc-game"]);
  });

  it("runs on the baseline budget like everything else", () => {
    // It used to be "the long recipe" at 1,000 turns, sliced 25 to a chunk on the
    // theory that made 40 durable chunks. Real turns here — a reasoning model plus
    // an ARC HTTP round trip — are far slower than that arithmetic assumed, so
    // runs took 70-100 chunks, blew the per-branch cap, and were killed after
    // hours instead of reporting. A game would still happily use more turns, which
    // is exactly why the number is not the game's to choose.
    expect(ARC_GAME_RECIPE.limits).toEqual({});
    expect(validateRecipe(ARC_GAME_RECIPE).limits).toEqual(SUBAGENT_LIMITS);
  });

  it("keeps a deliberately small context window, unlike its budget", () => {
    // The one thing it does tune, and the one thing that is genuinely a property
    // of the domain: the model leans on its workspace rather than its context.
    // Counts assistant messages, so a play spends it faster than the number looks.
    expect(ARC_GAME_RECIPE.historyWindow).toBeLessThan(
      SUBAGENT_LIMITS.maxTurns * 2
    );
  });
});

describe("what ARC_GAME_SPEC tells the main agent", () => {
  const guidance = ARC_GAME_SPEC.delegationGuidance!({
    delegateTool: "delegate",
    finalReplyTool: "final_reply"
  });

  it("owns both halves of it, so neither can drift from the other", () => {
    // Both used to be hand-written in `agent/` — the capability in the soul, the
    // guidance in the round contract — and they ended up disagreeing: one said to
    // delegate a subtask per game, the other said exactly one subtask and nothing
    // else. They are declared together now, and they agree.
    expect(ARC_GAME_SPEC.capability).toContain(
      "one `arc-game` subtask per game"
    );
    expect(guidance).toContain("per game");
    expect(guidance).not.toContain("exactly one");
  });

  it("names the param that starts a play and the tool that supplies it", () => {
    for (const text of [ARC_GAME_SPEC.capability!, guidance]) {
      expect(text).toContain("game_id");
      expect(text).toContain("arc_list_games");
      // The card is leased per chunk by the recipe; naming one here would invite
      // the model to pass a param the type does not declare.
      expect(text).not.toContain("card_id");
    }
  });

  it("leaves the params schema to the delegate tool description", () => {
    expect(guidance).not.toContain(ARC_GAME_SPEC.paramsHelp);
  });
});
