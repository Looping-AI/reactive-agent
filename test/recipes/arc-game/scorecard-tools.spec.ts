/**
 * The main agent's ARC tools (src/recipes/arc-game/scorecard-tools.ts): the
 * scorecard lifecycle plus the game catalogue.
 *
 * The store is the in-memory fake from ./helpers, so these exercise the tools'
 * own logic — the guard order around closing, and what each tool renders back to
 * the model — without a Durable Object. Coverage of the real response shapes
 * lives in recorded.spec.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildArcScorecardTools,
  closeScorecard,
  renderSummary,
  type ArcScorecardDeps
} from "@/recipes/arc-game/scorecard-tools";
import { makeArcClient } from "@/recipes/arc-game/client";
import type { ScorecardSummary } from "@/recipes/arc-game/types";
import { callTool, memStore } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** Route requests by path to canned responses; records which paths were hit. */
function stubFetch(routes: Record<string, () => unknown>) {
  const hits: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      hits.push(path);
      const handler = routes[path];
      return handler
        ? jsonResponse(handler())
        : new Response("no route", { status: 404 });
    })
  );
  return hits;
}

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

function deps(): ArcScorecardDeps {
  return { store: memStore(), client: makeArcClient("test-key") };
}

describe("arc scorecard tools", () => {
  it("lists games with their exact ids and tags", async () => {
    stubFetch({
      "/api/games": () => [
        { game_id: "ls20-abc", title: "LS20", tags: ["click"] },
        { game_id: "px7-def" }
      ]
    });
    const { arc_list_games } = buildArcScorecardTools(deps());

    const out = await callTool(arc_list_games, {});
    expect(out).toContain("- ls20-abc (LS20) [click]");
    expect(out).toContain("- px7-def");
  });

  it("opens a card, records it, and returns the id to quote", async () => {
    stubFetch({ "/api/scorecard/open": () => ({ card_id: "card-1" }) });
    const d = deps();
    const { arc_open_scorecard } = buildArcScorecardTools(d);

    const out = await callTool(arc_open_scorecard, {});
    expect(out).toContain("card-1");
    expect(d.store.listOpen().map((c) => c.cardId)).toEqual(["card-1"]);
  });

  it("lists scorecards from the store without calling the API", async () => {
    const hits = stubFetch({});
    const d = deps();
    d.store.open("card-open", {});
    d.store.open("card-done", {});
    d.store.close("card-done", SUMMARY({ card_id: "card-done" }));

    const out = await callTool(
      buildArcScorecardTools(d).arc_list_scorecards,
      {}
    );
    expect(out).toContain("card-open — open");
    expect(out).toContain("card-done — closed");
    expect(out).toContain("score 3");
    // The ARC API cannot list scorecards; this must be a pure read of our rows.
    expect(hits).toEqual([]);
  });

  it("closes a card and persists the aggregate", async () => {
    stubFetch({ "/api/scorecard/close": () => SUMMARY() });
    const d = deps();
    d.store.open("card-1", {});

    const out = await closeScorecard(d, "card-1");
    expect(out).toContain("Score 3");
    expect(out).toContain("2/6 levels");
    expect(out).toContain("ls20-abc");

    const card = d.store.get("card-1");
    expect(card?.status).toBe("closed");
    expect(card?.summary?.total_actions).toBe(41);
  });

  it("refuses to close a card it never opened, without calling the API", async () => {
    const hits = stubFetch({ "/api/scorecard/close": () => SUMMARY() });
    const out = await closeScorecard(deps(), "card-unknown");
    expect(out).toContain("No scorecard card-unknown");
    expect(hits).toEqual([]);
  });

  it("does not re-close a closed card, so the first score survives", async () => {
    const hits = stubFetch({ "/api/scorecard/close": () => SUMMARY() });
    const d = deps();
    d.store.open("card-1", {});
    d.store.close("card-1", SUMMARY({ score: 9 }));

    const out = await closeScorecard(d, "card-1");
    expect(out).toContain("already closed");
    expect(out).toContain("Score 9");
    expect(hits).toEqual([]);
    expect(d.store.get("card-1")?.summary?.score).toBe(9);
  });

  it("renders the aggregate and a line per game played", () => {
    const out = renderSummary(SUMMARY());
    expect(out).toContain("Scorecard card-1 closed");
    expect(out).toContain("Score 3 — 2/6 levels across 1 game(s), 41 actions");
    expect(out).toContain("- ls20-abc: 2/6 levels, 1 play(s)");
  });
});
