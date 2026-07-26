import { describe, it, expect } from "vitest";
import {
  SOUL,
  callerContext,
  scorecardContext,
  soulPrompt
} from "@/agent/prompt";
import type { Scorecard } from "@/recipes/arc-game/types";

const openCard = (cardId: string): Scorecard => ({
  cardId,
  status: "open",
  cookies: {},
  openedAt: 1,
  closedAt: null,
  summary: null
});

describe("SOUL", () => {
  it("includes the <turn> provenance awareness rule", () => {
    expect(SOUL.some((line) => line.includes("<turn"))).toBe(true);
  });

  it("tells the model to record durable facts via set_context", () => {
    expect(SOUL.some((line) => line.includes("set_context"))).toBe(true);
  });
});

describe("callerContext", () => {
  it("names the agent instance with its kind when both are present", () => {
    expect(callerContext({ name: "Demo Agent", kind: "custom" })).toContain(
      "Calling agent instance: Demo Agent (custom)."
    );
  });

  it("falls back to the instance key when name is absent", () => {
    expect(callerContext({ key: "custom:0:demo" })).toContain(
      "Calling agent instance: custom:0:demo."
    );
  });

  it("reports an unknown caller when the identity is empty", () => {
    expect(callerContext({})).toContain("unknown");
  });

  it("includes the workspace when present", () => {
    expect(callerContext({ name: "Demo Agent", workspaceId: 7 })).toContain(
      "Slack workspace: 7."
    );
  });
});

describe("scorecardContext", () => {
  it("is empty when no card is open, so non-players carry no ARC bookkeeping", () => {
    expect(scorecardContext([])).toBe("");
  });

  it("lists the open card ids for the model to quote when delegating", () => {
    const out = scorecardContext([openCard("card-1"), openCard("card-2")]);
    expect(out).toContain("Open ARC scorecards");
    expect(out).toContain("- card-1");
    expect(out).toContain("- card-2");
  });
});

describe("soulPrompt", () => {
  it("joins the SOUL lines into the frozen identity block (the Session's soul)", () => {
    const p = soulPrompt();
    expect(p.startsWith(SOUL[0])).toBe(true);
    expect(p).toContain(SOUL[SOUL.length - 1]);
  });

  it("teaches the scorecard lifecycle the main agent owns", () => {
    const p = soulPrompt();
    expect(p).toContain("arc_open_scorecard");
    expect(p).toContain("arc_close_scorecard");
    // The two rules no code path can enforce.
    expect(p).toContain("two different scorecards");
    expect(p).toContain("once every play on it has finished");
  });
});
