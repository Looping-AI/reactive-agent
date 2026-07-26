/**
 * The `arc-game` tool family (src/recipes/arc-game/tools.ts): reset / act /
 * inspect, with session state in an in-memory workspace.
 *
 * These specs script *synthetic* responses per request to exercise the
 * state-transition branches (level-up, GAME_OVER, unavailable action, replay) —
 * cases that can't be captured without actually solving a game. Coverage against
 * the *real* ARC API's response shapes lives in `recorded.spec.ts`, which drives
 * the deterministic flow through the undici SnapshotAgent VCR
 * (test/helpers/vcr.ts) instead of stubbing `fetch`.
 *
 * The family plays; it never opens or closes a scorecard. Several specs here
 * assert that negative directly, because it used to do both.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildArcGameTools } from "@/recipes/arc-game/tools";
import type { ArcSession } from "@/recipes/arc-game/types";
import { ctx, callTool } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const FRAME = (over: Record<string, unknown> = {}) => ({
  game_id: "ls20-abc",
  guid: "gid-1",
  frame: [
    [
      [0, 1],
      [2, 3]
    ]
  ],
  state: "NOT_FINISHED",
  levels_completed: 0,
  win_levels: 5,
  available_actions: [1, 2, 6],
  ...over
});

/** A mid-play session; `over` sets whatever the spec under test cares about. */
const SESSION = (over: Partial<ArcSession> = {}): ArcSession => ({
  cardId: "card-1",
  gameId: "ls20-abc",
  guid: "gid-1",
  cookies: {},
  winLevels: 5,
  levelsCompleted: 0,
  state: "NOT_FINISHED",
  availableActions: [1, 2],
  actionsSent: 0,
  playIndex: 0,
  plays: [],
  levelsReported: [],
  lastFrame: [[0]],
  prevFrame: null,
  pendingAction: null,
  ...over
});

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

/** Capture the JSON bodies posted to one path. */
function stubFetchCapturing(routes: Record<string, () => unknown>) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (typeof init?.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      const handler = routes[path];
      return handler
        ? jsonResponse(handler())
        : new Response("no route", { status: 404 });
    })
  );
  return bodies;
}

describe("arc-game tool family", () => {
  it("resets onto the card its params named and persists the session", async () => {
    const hits = stubFetch({ "/api/cmd/RESET": () => FRAME() });
    const { ctx: c } = ctx("test-key", {
      params: { card_id: "card-7", game_id: "ls20-abc" }
    });
    const { tools } = buildArcGameTools(c);

    const out = await callTool(tools.arc_reset_game, {});
    expect(out).toContain("Started ls20-abc");
    expect(out).toContain("card-7");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.cardId).toBe("card-7");
    expect(session?.guid).toBe("gid-1");
    expect(session?.availableActions).toEqual([1, 2, 6]);
    expect(session?.playIndex).toBe(0);
    expect(session?.plays).toEqual([]);
    // It was told both ids: it must not go looking for either.
    expect(hits).not.toContain("/api/games");
    expect(hits).not.toContain("/api/scorecard/open");
  });

  it("takes its ids from params, not from the model", async () => {
    const bodies = stubFetchCapturing({ "/api/cmd/RESET": () => FRAME() });
    const { ctx: c } = ctx("test-key", {
      params: { card_id: "card-7", game_id: "ls20-abc" }
    });
    const { tools } = buildArcGameTools(c);

    // No arguments: which game, on which card, was settled before the run.
    await callTool(tools.arc_reset_game, {});
    expect(bodies[0]).toMatchObject({
      game_id: "ls20-abc",
      card_id: "card-7"
    });
  });

  it("presents the parent's stored jar on the first RESET", async () => {
    const headers: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        headers.push(new Headers(init?.headers).get("cookie") ?? undefined);
        return jsonResponse(FRAME());
      })
    );
    const { ctx: c } = ctx("test-key", {
      runtime: { cookies: { GAMESESSION: "abc" } }
    });
    const { tools } = buildArcGameTools(c);

    // The ARC API pins a card to the session that opened it: without this jar
    // the card is invisible and RESET reports the game as not found.
    await callTool(tools.arc_reset_game, {});
    expect(headers[0]).toBe("GAMESESSION=abc");
  });

  it("rejects an action that is not currently available", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", SESSION());

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { action: 5 });
    expect(out).toContain("not available");
  });

  it("emits a level-up progress event keyed to the current play", async () => {
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ levels_completed: 1 }) });
    const { ctx: c, events } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1] })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { action: 1 });
    expect(out).toContain("level 1/5");
    expect(events).toEqual([
      {
        key: "arc:ls20-abc:play0:level:1",
        text: expect.stringContaining("reached level 1/5") as string
      }
    ]);
  });

  it("keeps level-up keys distinct across plays, so a replay still reports", async () => {
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ levels_completed: 1 }) });
    const { ctx: c, events } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1], playIndex: 1 })
    );

    const { tools } = buildArcGameTools(c);
    await callTool(tools.arc_act, { action: 1 });
    expect(events[0].key).toBe("arc:ls20-abc:play1:level:1");
  });

  it("never closes the scorecard when a play reaches GAME_OVER", async () => {
    const hits = stubFetch({
      "/api/cmd/ACTION1": () => FRAME({ state: "GAME_OVER" })
    });
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1] })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { action: 1 });
    expect(hits).not.toContain("/api/scorecard/close");
    expect(out).toContain("arc_reset_game");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.state).toBe("GAME_OVER");
  });

  it("tells the model to reset or report when acting on a finished play", async () => {
    const hits = stubFetch({});
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", SESSION({ state: "WIN" }));

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { action: 1 });
    expect(out).toContain("arc_reset_game");
    expect(hits).toEqual([]);
  });

  it("archives the finished play and starts a fresh one on re-reset", async () => {
    stubFetch({ "/api/cmd/RESET": () => FRAME({ guid: "gid-2" }) });
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        state: "GAME_OVER",
        levelsCompleted: 2,
        actionsSent: 17,
        levelsReported: [1, 2]
      })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_reset_game, {});
    expect(out).toContain("Restarted ls20-abc (play 2)");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.playIndex).toBe(1);
    expect(session?.guid).toBe("gid-2");
    expect(session?.state).toBe("NOT_FINISHED");
    // Per-play counters start over; the finished play is kept for the report.
    expect(session?.actionsSent).toBe(0);
    expect(session?.levelsReported).toEqual([]);
    expect(session?.plays).toEqual([
      {
        gameId: "ls20-abc",
        guid: "gid-1",
        state: "GAME_OVER",
        levelsCompleted: 2,
        actionsSent: 17
      }
    ]);
  });

  it("has no abort hook — the scorecard is not the subagent's to release", () => {
    const { ctx: c } = ctx();
    expect(buildArcGameTools(c).abort).toBeUndefined();
  });
});
