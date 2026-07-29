/**
 * The agent's view of the type set (src/agent/subtasks/subtask-types.ts): lookup,
 * the delegate enum, and the params contract each type owns — all of it derived
 * from the manifest in `src/recipes/index.ts`, which is what actually declares
 * the set.
 *
 * Two distinctions carry the weight here and are asserted directly, because
 * conflating them is the easy mistake: a *type* is what the work is and what it
 * requires, a *Recipe* is only the configuration it runs under — several types
 * may share one Recipe, and a Recipe never declares params.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  SUBTASK_TYPES,
  SUBTASK_TYPE_KEYS,
  SubtaskParamsError,
  renderDelegationGuidance,
  renderSubtaskTypes,
  renderTypeCapabilities,
  resolveRecipeForType,
  subtaskParamProperties,
  subtaskTypeSpec,
  validateSubtaskParams
} from "@/agent/subtasks/subtask-types";
import { SUBTASK_TYPE_SPECS } from "@/recipes";
import { validateRecipe } from "@/recipes/validation";
import { MAIN_AGENT_LIMITS, MAX_SUBTASKS } from "@/config";
import { MAX_CHUNKS_PER_BRANCH, STEPS_PER_INSTANCE } from "@/platform";
import { GENERAL_RECIPE, GENERAL_TYPE } from "@/recipes/general/recipe";
import { ARC_GAME_RECIPE, ARC_GAME_TYPE } from "@/recipes/arc-game/recipe";

describe("the type set", () => {
  it("is closed, and contains the types the agent can actually run", () => {
    expect(SUBTASK_TYPE_KEYS).toEqual([GENERAL_TYPE, ARC_GAME_TYPE]);
  });

  it("derives itself from the manifest, in manifest order", () => {
    // The agent names no domain: every type it knows comes from `recipes/index`.
    expect(SUBTASK_TYPE_KEYS).toEqual(SUBTASK_TYPE_SPECS.map((s) => s.key));
    expect(SUBTASK_TYPES.size).toBe(SUBTASK_TYPE_SPECS.length);
  });

  it("maps each type to the Recipe it runs under", () => {
    expect(resolveRecipeForType(GENERAL_TYPE)).toBe(GENERAL_RECIPE);
    expect(resolveRecipeForType(ARC_GAME_TYPE)).toBe(ARC_GAME_RECIPE);
  });

  it("refuses to resolve a type it no longer knows", () => {
    // The enum keeps unknown types out of new delegations, so a type reaching
    // execution that we cannot resolve is a configuration bug: fail terminally
    // rather than silently running it under some other domain's Recipe.
    expect(() => resolveRecipeForType("retired-type")).toThrow(
      SubtaskParamsError
    );
    expect(() => resolveRecipeForType("retired-type")).toThrow(
      /unknown subtask type/
    );
  });

  it("shows the model each type and how to obtain its params", () => {
    const rendered = renderSubtaskTypes();
    expect(rendered).toContain(`\`${GENERAL_TYPE}\``);
    expect(rendered).toContain(`\`${ARC_GAME_TYPE}\``);
    expect(rendered).toContain("arc_list_games");
    // The card is leased by the recipe, so no type may advertise one.
    expect(rendered).not.toContain("card_id");
  });

  // `MAX_CHUNKS_PER_BRANCH` is a platform backstop, not a budget: the Workflow
  // *fails* a branch that reaches it. These two assertions are what hold it
  // unreachable, and they live over the whole manifest because a new recipe is
  // exactly where either would be broken.
  describe("the per-branch chunk cap stays unreachable", () => {
    it("exceeds every recipe's turn budget", () => {
      // A yielding chunk always advanced at least one turn, so a run takes at
      // most `maxTurns` chunks no matter how short they are — and they do get
      // short: `CHUNK_SOFT_MS` and progress events both end one early. That is
      // how an earlier 1,000-turn recipe produced 70-100 chunks against a
      // 40-chunk estimate and was killed at the cap instead of reporting. Hold
      // this and a branch always ends through the graceful budget summary.
      for (const spec of SUBTASK_TYPE_SPECS) {
        const { maxTurns } = validateRecipe(spec.recipe).limits;
        expect(maxTurns).toBeLessThan(MAX_CHUNKS_PER_BRANCH);
      }
    });

    it("keeps the worst-case step count under the Workflows instance ceiling", () => {
      // Per round: the deadline probe, the turn, up to MAX_SUBTASKS + 1 wave
      // scans, and every branch running to the cap plus its failure step. Rounds
      // are bounded by the main agent's turn budget, since an open round always
      // spends at least one turn. This product is what lets a separate whole-Task
      // chunk budget not exist.
      const perRound =
        2 + (MAX_SUBTASKS + 1) + MAX_SUBTASKS * (MAX_CHUNKS_PER_BRANCH + 1);
      // maxTurns open rounds plus the forced-answer round, matching the loop.
      const worstCase = (MAIN_AGENT_LIMITS.maxTurns + 1) * perRound + 3;
      expect(worstCase).toBeLessThan(STEPS_PER_INSTANCE);
    });
  });
});

describe("validateSubtaskParams", () => {
  it("accepts a type that takes no params", () => {
    expect(validateSubtaskParams(GENERAL_TYPE, undefined)).toEqual({});
    expect(validateSubtaskParams(GENERAL_TYPE, {})).toEqual({});
  });

  it("rejects params on a type that declares none", () => {
    // A stray param would otherwise ride along unread, looking meaningful.
    expect(() =>
      validateSubtaskParams(GENERAL_TYPE, { card_id: "card-1" })
    ).toThrow(SubtaskParamsError);
  });

  it("accepts the params an arc-game play requires", () => {
    expect(
      validateSubtaskParams(ARC_GAME_TYPE, { game_id: "ls20-abc" })
    ).toEqual({ game_id: "ls20-abc" });
  });

  it("drops a card named by the delegating model", () => {
    // Which card a play runs on is leased per chunk, not chosen, so a `card_id`
    // is a model inventing state it cannot know. Stripping it beats refusing the
    // subtask: the play is still perfectly valid, and the invented id provably
    // cannot reach the execution.
    expect(
      validateSubtaskParams(ARC_GAME_TYPE, {
        game_id: "ls20-abc",
        card_id: "card-1"
      })
    ).toEqual({ game_id: "ls20-abc" });
  });

  it("rejects an arc-game subtask that names no game", () => {
    expect(() => validateSubtaskParams(ARC_GAME_TYPE, {})).toThrow(/game_id/);
  });

  it("rejects a blank id, which would fail at the API with no diagnostic", () => {
    expect(() => validateSubtaskParams(ARC_GAME_TYPE, { game_id: "" })).toThrow(
      SubtaskParamsError
    );
  });

  it("rejects an unknown type outright", () => {
    expect(() => validateSubtaskParams("warp", {})).toThrow(
      /unknown subtask type/
    );
  });

  it("names the offending type in the error, since it fails a whole attempt", () => {
    expect(() => validateSubtaskParams(ARC_GAME_TYPE, {})).toThrow(
      new RegExp(ARC_GAME_TYPE)
    );
  });
});

describe("subtaskParamProperties", () => {
  it("derives itself from the manifest, naming every declared key", () => {
    // The agent names no domain here either: the delegate schema's param keys
    // come from the types that declare them, so a new domain is still a new
    // folder plus a line in `recipes/index` — with no edit inside `agent/`.
    const declared = SUBTASK_TYPE_SPECS.flatMap((spec) =>
      spec.params ? Object.keys(spec.params.shape) : []
    );
    expect(Object.keys(subtaskParamProperties()).sort()).toEqual(
      [...new Set(declared)].sort()
    );
  });

  it("makes every key optional, since each is required by one type only", () => {
    // One flat object serves every type; requiredness stays per-type, in
    // `validateSubtaskParams`, which is what actually refuses a bad subtask.
    const params = z.object(subtaskParamProperties());
    expect(params.safeParse({}).success).toBe(true);
    expect(params.safeParse({ game_id: "ls20-abc" }).success).toBe(true);
  });

  it("attributes each key to the type that declares it", () => {
    const described = subtaskParamProperties().game_id.description;
    expect(described).toContain(ARC_GAME_TYPE);
    // The owning type's own words survive the prefix — that text is how the
    // model learns where to get the id.
    expect(described).toContain("arc_list_games");
  });

  it("keeps the value contract of the declaring type", () => {
    // A blank id is refused here too, not just downstream: it would otherwise
    // reach the ARC API and fail there with no useful diagnostic.
    expect(subtaskParamProperties().game_id.safeParse("").success).toBe(false);
  });
});

describe("the prompt text the manifest contributes", () => {
  const NAMES = { delegateTool: "delegate", finalReplyTool: "final_reply" };

  it("renders every declared block, and only those, in manifest order", () => {
    const capabilities = renderTypeCapabilities();
    const guidance = renderDelegationGuidance(NAMES);
    const declared = SUBTASK_TYPE_SPECS.filter((s) => s.capability);
    const guided = SUBTASK_TYPE_SPECS.filter((s) => s.delegationGuidance);

    expect(declared.length).toBeGreaterThan(0);
    expect(guided.length).toBeGreaterThan(0);
    for (const spec of declared)
      expect(capabilities).toContain(spec.capability);
    for (const spec of guided) {
      expect(guidance).toContain(spec.delegationGuidance!(NAMES));
    }
    // `general` declares neither: a catch-all needs no introduction beyond its
    // one-line description, and every round would pay for one.
    const general = subtaskTypeSpec(GENERAL_TYPE);
    expect(general?.capability).toBeUndefined();
    expect(general?.delegationGuidance).toBeUndefined();
  });

  it("carries its own separators and no stray ones", () => {
    // Both call sites splice these into a prompt, so a leading or trailing blank
    // line is theirs to add — a skipped type must cost nothing at all.
    for (const rendered of [
      renderTypeCapabilities(),
      renderDelegationGuidance(NAMES)
    ]) {
      expect(rendered).toBe(rendered.trim());
      expect(rendered).not.toContain("\n\n\n");
    }
  });

  it("gives guidance the control-tool names rather than letting it hardcode them", () => {
    // The whole reason guidance is a function: a domain may say "ask the user
    // with `final_reply`" without importing anything from `agent/`.
    const renamed = renderDelegationGuidance({
      delegateTool: "hand_off",
      finalReplyTool: "answer_now"
    });
    expect(renamed).toContain("answer_now");
    expect(renamed).not.toContain("final_reply");
  });

  it("keeps every guidance section a section — its own `## ` heading", () => {
    // Guidance is concatenated into a markdown prompt; a block that opens with
    // prose would read as a continuation of whatever preceded it.
    for (const spec of SUBTASK_TYPE_SPECS) {
      if (!spec.delegationGuidance) continue;
      expect(spec.delegationGuidance(NAMES).startsWith("## ")).toBe(true);
    }
  });
});

describe("subtaskTypeSpec", () => {
  it("declares params on the type, never on the Recipe", () => {
    const arc = subtaskTypeSpec(ARC_GAME_TYPE);
    expect(arc?.params).not.toBeNull();
    expect(arc?.recipe).toBe(ARC_GAME_RECIPE);
    // A Recipe is a configuration; it knows nothing about the contract.
    expect(ARC_GAME_RECIPE).not.toHaveProperty("params");
    expect(ARC_GAME_RECIPE).not.toHaveProperty("paramsSchema");
  });

  it("returns null for a type outside the set", () => {
    expect(subtaskTypeSpec("warp")).toBeNull();
  });
});
