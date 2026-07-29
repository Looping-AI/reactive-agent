import { describe, it, expect } from "vitest";
import { SOUL, callerContext, soulPrompt } from "@/agent/prompt";

describe("SOUL", () => {
  it("includes the <turn> provenance awareness rule", () => {
    expect(SOUL.some((line) => line.includes("<turn"))).toBe(true);
  });

  it("tells the model to record durable facts via set_context", () => {
    expect(SOUL.some((line) => line.includes("set_context"))).toBe(true);
  });

  it("names no domain of its own", () => {
    // The soul is the frozen identity, true of every request. What the agent can
    // do with ARC is declared by the `arc-game` type and rendered from the
    // manifest, so text reaching soulPrompt() below can only have come from there.
    for (const domain of ["ARC", "arc-game", "arc_", "game_id"]) {
      expect(SOUL.join("\n")).not.toContain(domain);
    }
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

describe("soulPrompt", () => {
  it("joins the SOUL lines into the frozen identity block (the Session's soul)", () => {
    const p = soulPrompt();
    expect(p.startsWith(SOUL[0])).toBe(true);
    expect(p).toContain(SOUL[SOUL.length - 1]);
  });

  it("teaches how to delegate a play and where the score comes from", () => {
    const p = soulPrompt();
    expect(p).toContain("arc_list_games");
    expect(p).toContain("`game_id`");
    expect(p).toContain("Report that score rather than inventing one");
  });

  it("offers the main agent no scorecard vocabulary at all", () => {
    // The card is leased by the recipe. Naming a scorecard tool here would
    // invite the model to call one that no longer exists, and naming a card id
    // would invite it to pass one as a param the type no longer declares.
    const p = soulPrompt();
    expect(p).not.toContain("arc_open_scorecard");
    expect(p).not.toContain("arc_close_scorecard");
    expect(p).not.toContain("arc_list_scorecards");
    expect(p).not.toContain("card_id");
  });
});
