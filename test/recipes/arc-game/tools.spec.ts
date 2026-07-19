/**
 * The `arc-game` tool family (src/recipes/arc-game/tools.ts): start / act /
 * inspect, with session state in an in-memory workspace.
 *
 * These specs script *synthetic* responses per request to exercise the
 * state-transition branches (level-up, GAME_OVER, unavailable action) — cases
 * that can't be captured without actually solving a game. Coverage against the
 * *real* ARC API's response shapes lives in `recorded.spec.ts`, which drives the
 * deterministic start/abort flow through the undici SnapshotAgent VCR
 * (test/helpers/vcr.ts) instead of stubbing `fetch`.
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

describe("arc-game tool family", () => {
  it("starts a game, resolving a prefix, and persists the session", async () => {
    stubFetch({
      "/api/games": () => [{ game_id: "ls20-abc", title: "LS20" }],
      "/api/scorecard/open": () => ({ card_id: "card-1" }),
      "/api/cmd/RESET": () => FRAME()
    });
    const { ctx: c } = ctx();
    const { tools } = buildArcGameTools(c);

    const out = await callTool(tools.arc_start_game, { game: "ls20" });
    expect(out).toContain("Started ls20-abc");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.cardId).toBe("card-1");
    expect(session?.guid).toBe("gid-1");
    expect(session?.availableActions).toEqual([1, 2, 6]);
  });

  it("reports the available games when the name has no unique match", async () => {
    stubFetch({
      "/api/games": () => [{ game_id: "ls20-abc" }, { game_id: "px7-def" }]
    });
    const { ctx: c } = ctx();
    const { tools } = buildArcGameTools(c);

    const out = await callTool(tools.arc_start_game, { game: "nope" });
    expect(out).toContain("No unique match");
    expect(out).toContain("ls20-abc");
    expect(out).toContain("px7-def");
  });

  it("rejects an action that is not currently available", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", {
      gameId: "ls20-abc",
      guid: "gid-1",
      availableActions: [1, 2],
      state: "NOT_FINISHED",
      levelsCompleted: 0,
      winLevels: 5,
      cardId: "card-1",
      cookies: {},
      actionsSent: 0,
      levelsReported: [],
      lastFrame: [[0]],
      prevFrame: null,
      pendingAction: null,
      gameTitle: "LS20",
      scorecardClosed: false
    } satisfies ArcSession);

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { action: 5 });
    expect(out).toContain("not available");
  });

  it("emits a level-up progress event when levels_completed rises", async () => {
    stubFetch({ "/api/cmd/ACTION1": () => FRAME({ levels_completed: 1 }) });
    const { ctx: c, events } = ctx();
    await c.workspace.writeJson("arc/session.json", {
      gameId: "ls20-abc",
      guid: "gid-1",
      availableActions: [1],
      state: "NOT_FINISHED",
      levelsCompleted: 0,
      winLevels: 5,
      cardId: "card-1",
      cookies: {},
      actionsSent: 0,
      levelsReported: [],
      lastFrame: [[0]],
      prevFrame: null,
      pendingAction: null,
      gameTitle: "LS20",
      scorecardClosed: false
    } satisfies ArcSession);

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { action: 1 });
    expect(out).toContain("level 1/5");
    expect(events).toEqual([
      {
        key: "arc:level:1",
        text: expect.stringContaining("reached level 1/5") as string
      }
    ]);
  });

  it("closes the scorecard when the game reaches GAME_OVER", async () => {
    const hits = stubFetch({
      "/api/cmd/ACTION1": () => FRAME({ state: "GAME_OVER" }),
      "/api/scorecard/close": () => ({ ok: true })
    });
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", {
      gameId: "ls20-abc",
      guid: "gid-1",
      availableActions: [1],
      state: "NOT_FINISHED",
      levelsCompleted: 0,
      winLevels: 5,
      cardId: "card-1",
      cookies: {},
      actionsSent: 0,
      levelsReported: [],
      lastFrame: [[0]],
      prevFrame: null,
      pendingAction: null,
      gameTitle: "LS20",
      scorecardClosed: false
    } satisfies ArcSession);

    const { tools } = buildArcGameTools(c);
    await callTool(tools.arc_act, { action: 1 });
    expect(hits).toContain("/api/scorecard/close");
    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.scorecardClosed).toBe(true);
  });

  it("abort closes an open scorecard from the workspace session", async () => {
    const hits = stubFetch({ "/api/scorecard/close": () => ({ ok: true }) });
    const { ctx: c } = ctx();
    await c.workspace.writeJson("arc/session.json", {
      gameId: "ls20-abc",
      guid: "gid-1",
      availableActions: [1],
      state: "NOT_FINISHED",
      levelsCompleted: 0,
      winLevels: 5,
      cardId: "card-9",
      cookies: {},
      actionsSent: 3,
      levelsReported: [],
      lastFrame: [[0]],
      prevFrame: null,
      pendingAction: null,
      gameTitle: "LS20",
      scorecardClosed: false
    } satisfies ArcSession);

    const built = buildArcGameTools(c);
    await built.abort?.(c);
    expect(hits).toContain("/api/scorecard/close");
  });
});
