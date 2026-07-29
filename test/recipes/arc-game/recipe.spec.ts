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
import { MAX_CHUNKS_PER_BRANCH } from "@/platform";

describe("ARC_GAME_RECIPE", () => {
  it("is the enabled arc-game recipe, playing and nothing else", () => {
    const recipe = resolveRecipeForType(ARC_GAME_TYPE);
    expect(recipe.key).toBe(ARC_GAME_TYPE);
    expect(recipe.reportMetrics).toBe(true);
    // It used to carry `workspace` too, so the model could keep notes in files.
    // Across two logged plays it wrote three and read none, at a turn apiece; the
    // `note` field of `arc_act` carries a plan for free instead. The session file
    // is untouched by this — the family reaches the workspace through its context,
    // not through tools a model can call.
    expect(recipe.toolFamilies).toEqual(["arc-game"]);
  });

  it("buys more turns than the baseline, and stops short of the chunk cap", () => {
    // It used to be "the long recipe" at 1,000 turns, sliced 25 to a chunk on the
    // theory that made 40 durable chunks. Real turns here — a reasoning model plus
    // an ARC HTTP round trip — are far slower than that arithmetic assumed, so runs
    // took 70-100 chunks, blew the per-branch cap, and were killed after hours
    // instead of reporting. The correction was not to leave a play on the baseline:
    // 20 turns bought about ten game actions once inspection was paid for. It is
    // the *shape* of the old number that was wrong, and 39 is the most a recipe can
    // ask for while a yielding chunk still costs a turn — see the assertion over
    // every recipe in `test/agent/subtasks/subtask-types.spec.ts`.
    expect(ARC_GAME_RECIPE.limits.maxTurns).toBeGreaterThan(
      SUBAGENT_LIMITS.maxTurns
    );
    expect(ARC_GAME_RECIPE.limits.maxTurns).toBeLessThan(MAX_CHUNKS_PER_BRANCH);
    // Time is not overridden: turns are what a play is short of, and the two
    // ceilings end a run identically, so the baseline stands until a run is
    // observed ending on the clock.
    expect(ARC_GAME_RECIPE.limits.maxWallMs).toBeUndefined();
    expect(validateRecipe(ARC_GAME_RECIPE).limits.maxWallMs).toBe(
      SUBAGENT_LIMITS.maxWallMs
    );
  });

  it("keeps a context window smaller than its budget, since it is now the only memory", () => {
    // The one thing it genuinely tunes as a property of the domain. It counts
    // assistant messages, so a play spends it faster than the number looks — and
    // with the workspace tools gone, a plan that scrolls out of it is gone.
    expect(ARC_GAME_RECIPE.historyWindow).toBeLessThan(
      validateRecipe(ARC_GAME_RECIPE).limits.maxTurns
    );
    expect(ARC_GAME_RECIPE.historyWindow).toBeGreaterThan(24);
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
