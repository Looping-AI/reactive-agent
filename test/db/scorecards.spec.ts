/**
 * Unit tests for the `scorecards` data layer (src/db/models/scorecards.ts).
 *
 * Each test constructs a real AgentDB against a fresh DO storage so every query
 * runs through the actual Drizzle + SQLite stack with real migrations — no
 * mocks, no stubs. Mirrors test/db/subtasks.spec.ts.
 *
 * This table is the *only* record of a scorecard: the ARC API can neither list
 * cards nor re-read a closed one, so the specs below lean on the guarded close
 * (a second close must not overwrite the first, real summary) and on the summary
 * surviving a round-trip intact.
 */
import { describe, it, expect } from "vitest";
import type { ScorecardSummary } from "@/recipes/arc-game/types";
import { withScorecards } from "../helpers/do";

const SUMMARY = (over: Partial<ScorecardSummary> = {}): ScorecardSummary => ({
  card_id: "card-1",
  score: 3,
  total_actions: 41,
  total_environments: 1,
  total_environments_completed: 0,
  total_levels: 6,
  total_levels_completed: 2,
  environments: [
    {
      id: "ls20-abc",
      actions: 41,
      completed: false,
      level_count: 6,
      levels_completed: 2,
      resets: 1,
      score: 3,
      runs: [
        {
          guid: "gid-1",
          actions: 41,
          completed: false,
          levels_completed: 2,
          resets: 0,
          score: 3,
          state: "GAME_OVER"
        }
      ]
    }
  ],
  ...over
});

describe("scorecards.open", () => {
  it("records a card as open with no summary yet", async () => {
    const card = await withScorecards("sc-open", (s) => s.open("card-1", {}));
    expect(card.cardId).toBe("card-1");
    expect(card.status).toBe("open");
    expect(card.closedAt).toBeNull();
    expect(card.summary).toBeNull();
    expect(card.openedAt).toBeGreaterThan(0);
  });

  it("lists only the open cards, newest first", async () => {
    const open = await withScorecards("sc-listopen", (s) => {
      s.open("card-1", {});
      s.open("card-2", {});
      s.close("card-1", SUMMARY());
      return s.listOpen().map((c) => c.cardId);
    });
    expect(open).toEqual(["card-2"]);
  });
});

describe("scorecards.close", () => {
  it("persists the aggregate and round-trips it intact", async () => {
    const card = await withScorecards("sc-close", (s) => {
      s.open("card-1", {});
      s.close("card-1", SUMMARY());
      return s.get("card-1");
    });
    expect(card?.status).toBe("closed");
    expect(card?.closedAt).toBeGreaterThan(0);
    expect(card?.summary).toEqual(SUMMARY());
  });

  it("keeps unknown fields the API may add, since nothing else records them", async () => {
    const card = await withScorecards("sc-loose", (s) => {
      s.open("card-1", {});
      s.close("card-1", {
        ...SUMMARY(),
        some_new_field: "keep me"
      } as ScorecardSummary);
      return s.get("card-1");
    });
    expect(
      (card?.summary as unknown as { some_new_field: string }).some_new_field
    ).toBe("keep me");
  });

  it("is a no-op on an already-closed card, so the first score survives", async () => {
    const result = await withScorecards("sc-reclose", (s) => {
      s.open("card-1", {});
      s.close("card-1", SUMMARY({ score: 9 }));
      const again = s.close("card-1", SUMMARY({ score: 1 }));
      return { again, card: s.get("card-1") };
    });
    expect(result.again).toBe(false);
    expect(result.card?.summary?.score).toBe(9);
  });

  it("is a no-op on an unknown card", async () => {
    const closed = await withScorecards("sc-unknown", (s) =>
      s.close("nope", SUMMARY())
    );
    expect(closed).toBe(false);
  });
});

describe("scorecards.listRecent", () => {
  it("returns open and closed cards together, newest first, capped", async () => {
    const ids = await withScorecards("sc-recent", (s) => {
      s.open("card-1", {});
      s.open("card-2", {});
      s.open("card-3", {});
      s.close("card-1", SUMMARY());
      return s.listRecent(2).map((c) => c.cardId);
    });
    expect(ids).toHaveLength(2);
    expect(ids).toContain("card-3");
  });

  it("returns nothing before any card is opened", async () => {
    const ids = await withScorecards("sc-empty", (s) => s.listRecent(10));
    expect(ids).toEqual([]);
  });
});
