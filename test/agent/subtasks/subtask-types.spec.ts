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
import {
  SUBTASK_TYPES,
  SUBTASK_TYPE_KEYS,
  SubtaskParamsError,
  renderSubtaskTypes,
  resolveRecipeForType,
  subtaskTypeSpec,
  validateSubtaskParams
} from "@/agent/subtasks/subtask-types";
import { SUBTASK_TYPE_SPECS } from "@/recipes";
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

  it("falls back to the general Recipe for a type it no longer knows", () => {
    // The enum keeps unknown types out of new delegations, but rows persisted
    // before a type was renamed or retired must still be executable.
    expect(resolveRecipeForType("retired-type")).toBe(GENERAL_RECIPE);
  });

  it("shows the model each type and how to obtain its params", () => {
    const rendered = renderSubtaskTypes();
    expect(rendered).toContain(`\`${GENERAL_TYPE}\``);
    expect(rendered).toContain(`\`${ARC_GAME_TYPE}\``);
    expect(rendered).toContain("arc_open_scorecard");
    expect(rendered).toContain("arc_list_games");
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
      validateSubtaskParams(ARC_GAME_TYPE, {
        card_id: "card-1",
        game_id: "ls20-abc"
      })
    ).toEqual({ card_id: "card-1", game_id: "ls20-abc" });
  });

  it("rejects an arc-game subtask that names no scorecard", () => {
    expect(() =>
      validateSubtaskParams(ARC_GAME_TYPE, { game_id: "ls20-abc" })
    ).toThrow(/card_id/);
  });

  it("rejects an arc-game subtask that names no game", () => {
    expect(() =>
      validateSubtaskParams(ARC_GAME_TYPE, { card_id: "card-1" })
    ).toThrow(/game_id/);
  });

  it("rejects a blank id, which would fail at the API with no diagnostic", () => {
    expect(() =>
      validateSubtaskParams(ARC_GAME_TYPE, { card_id: "", game_id: "ls20-abc" })
    ).toThrow(SubtaskParamsError);
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
