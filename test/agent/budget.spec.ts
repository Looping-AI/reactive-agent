import { describe, it, expect } from "vitest";
import { newTurnBudget, stepAllowance } from "@/agent/budget";

describe("newTurnBudget", () => {
  it("starts unspent", () => {
    expect(newTurnBudget(20)).toEqual({ allowance: 20, spent: 0 });
  });
});

describe("stepAllowance", () => {
  it("hands out what is left", () => {
    expect(stepAllowance(20, 0)).toBe(20);
    expect(stepAllowance(20, 7)).toBe(13);
    expect(stepAllowance(20, 19)).toBe(1);
  });

  it("still gives a spent budget one step", () => {
    // The floor, and the reason a round may exceed its allowance by exactly one:
    // a fallback with nothing to spend cannot reach an ending, which fails the
    // round and costs the caller the answer the budget exists to extract.
    expect(stepAllowance(20, 20)).toBe(1);
    expect(stepAllowance(20, 25)).toBe(1);
    expect(stepAllowance(0, 0)).toBe(1);
  });

  it("bounds a primary/fallback pair at one over, never at double", () => {
    // What the two attempts of one round actually draw, in order. This is the
    // arithmetic the review found broken when each attempt got its own number.
    const allowance = 3;
    let spent = 0;
    spent += stepAllowance(allowance, spent); // primary takes all 3
    expect(spent).toBe(3);
    spent += stepAllowance(allowance, spent); // fallback gets the floor's 1
    expect(spent).toBe(allowance + 1);
  });
});
