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
  lastGridHex: "0",
  pendingAction: null,
  ...over
});

/** `arc_act` with a single step — the shape most specs here want. */
const one = (action: number, x?: number, y?: number) => ({
  steps: [
    {
      action,
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y })
    }
  ]
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
  it("resets onto the leased card and persists the session", async () => {
    const hits = stubFetch({ "/api/cmd/RESET": () => FRAME() });
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-7" }
    });
    const { tools } = buildArcGameTools(c);

    const out = await callTool(tools.arc_reset_game, {});
    expect(out).toContain("Started ls20-abc");
    // The card is not the model's business, so it is not narrated back to it.
    expect(out).not.toContain("card-7");

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

  it("takes its ids from params and runtime, not from the model", async () => {
    const bodies = stubFetchCapturing({ "/api/cmd/RESET": () => FRAME() });
    const { ctx: c } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-7" }
    });
    const { tools } = buildArcGameTools(c);

    // No arguments: which game, on which card, was settled before the run.
    await callTool(tools.arc_reset_game, {});
    expect(bodies[0]).toMatchObject({
      game_id: "ls20-abc",
      card_id: "card-7"
    });
  });

  it("keeps a play on its own card when the lease has since rolled over", async () => {
    // A play's later runs must land on the card its earlier runs did, or the
    // scorecard splits one game across two cards.
    const bodies = stubFetchCapturing({
      "/api/cmd/RESET": () => FRAME({ state: "GAME_OVER" })
    });
    const { ctx: first } = ctx("test-key", {
      params: { game_id: "ls20-abc" },
      runtime: { cardId: "card-old" }
    });
    await callTool(buildArcGameTools(first).tools.arc_reset_game, {});

    // Same workspace, new lease: the second RESET must still name the old card.
    const second: typeof first = { ...first, runtime: { cardId: "card-new" } };
    await callTool(buildArcGameTools(second).tools.arc_reset_game, {});

    expect(bodies[1]).toMatchObject({ card_id: "card-old" });
    const session =
      await first.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.cardId).toBe("card-old");
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
    const out = await callTool(tools.arc_act, one(5));
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
    const out = await callTool(tools.arc_act, one(1));
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
    await callTool(tools.arc_act, one(1));
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
    const out = await callTool(tools.arc_act, one(1));
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
    const out = await callTool(tools.arc_act, one(1));
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

/**
 * Sequences are only safe if each step's effect is attributable to that step. A
 * batch that reported one lumped diff would be strictly worse than the same
 * actions sent one at a time, because the model would learn that the board moved
 * but not which action moved it — so these specs are mostly about attribution.
 */
describe("arc_act sequences", () => {
  /** Frames whose boards differ per call, so a mis-paired diff is visible. */
  function stubFrames(frames: Array<Record<string, unknown>>) {
    let i = 0;
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        paths.push(new URL(String(url)).pathname);
        return jsonResponse(frames[Math.min(i++, frames.length - 1)]);
      })
    );
    return paths;
  }

  /** A 2×2 board as a frame response body. */
  const boardFrame = (grid: number[][], over: Record<string, unknown> = {}) =>
    FRAME({ frame: [grid], available_actions: [1, 2, 4, 6], ...over });

  it("sends every step in order and attributes each change to its own action", async () => {
    // A single cell walks right one column per action.
    const paths = stubFrames([
      boardFrame([
        [0, 9],
        [0, 0]
      ]),
      boardFrame([
        [0, 0],
        [0, 9]
      ])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [1, 4, 6],
        // Board starts with the cell at (0,0).
        lastGridHex: "90\n00"
      })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 2 }]
    });

    expect(paths).toEqual(["/api/cmd/ACTION4", "/api/cmd/ACTION2"]);
    expect(out).toContain("2 steps requested, 2 sent.");
    // Step 1 moved (0,0)->(0,1); step 2 moved (0,1)->(1,1). Each line describes
    // only its own action's change, diffed against the board just before it.
    expect(out).toContain("1. right → 2 cells changed, row 0, cols 0-1");
    expect(out).toContain("(0,0) blue->white, (0,1) white->blue");
    expect(out).toContain("2. down → 2 cells changed, rows 0-1, col 1");
    expect(out).toContain("(0,1) blue->white, (1,1) white->blue");

    const session = await c.workspace.readJson<ArcSession>("arc/session.json");
    expect(session?.actionsSent).toBe(2);
    expect(session?.lastGridHex).toBe("00\n09");
    expect(session?.pendingAction).toBeNull();
  });

  it("reports a step that changed nothing as a real result, not a gap", async () => {
    stubFrames([
      boardFrame([
        [9, 0],
        [0, 0]
      ])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4], lastGridHex: "90\n00" })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { steps: [{ action: 4 }] });
    expect(out).toContain("0 cells changed (no effect)");
  });

  it("stops the sequence and names the unsent tail when an action goes unavailable", async () => {
    // The first action succeeds but narrows what is legal next.
    const paths = stubFrames([
      boardFrame([[0]], { available_actions: [1] }),
      boardFrame([[0]])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [4] })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 4 }, { action: 4 }, { action: 4 }]
    });

    // Only one action reached the API: the rest would have been rejected.
    expect(paths).toEqual(["/api/cmd/ACTION4"]);
    expect(out).toContain("4 steps requested, 1 sent.");
    expect(out).toContain("2-4. not sent: right is not available");
  });

  it("stops the sequence when the play ends mid-batch", async () => {
    const paths = stubFrames([
      boardFrame([[0]]),
      boardFrame([[1]], { state: "WIN" }),
      boardFrame([[2]])
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [1, 4, 6] })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, {
      steps: [{ action: 4 }, { action: 4 }, { action: 4 }]
    });

    expect(paths).toHaveLength(2);
    expect(out).toContain("3. not sent: state became WIN");
    expect(out).toContain("This play is over");
  });

  it("carries per-step click coordinates, not one pair for the whole batch", async () => {
    const bodies = stubFetchCapturing({
      "/api/cmd/ACTION6": () => FRAME({ available_actions: [6] })
    });
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [6] })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, {
      steps: [
        { action: 6, x: 12, y: 34 },
        { action: 6, x: 56, y: 7 }
      ]
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ x: 12, y: 34 });
    expect(bodies[1]).toMatchObject({ x: 56, y: 7 });
    // The label carries the coordinates too, so a trace of clicks is readable.
    expect(out).toContain("1. click(12,34)");
    expect(out).toContain("2. click(56,7)");
  });

  it("refuses a click with no coordinates without spending the action", async () => {
    const paths = stubFrames([boardFrame([[0]])]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ availableActions: [6] })
    );

    const { tools } = buildArcGameTools(c);
    const out = await callTool(tools.arc_act, { steps: [{ action: 6 }] });
    expect(paths).toEqual([]);
    expect(out).toContain("requires x and y");
  });

  it("budgets cell detail across the batch so a long sequence cannot flood context", async () => {
    // Every action repaints the whole 4×4 board, so each step has 16 changes and
    // the per-step cell cap is what bounds the output.
    const filled = (v: number) =>
      boardFrame(Array.from({ length: 4 }, () => new Array(4).fill(v)));
    stubFrames([
      filled(1),
      filled(2),
      filled(3),
      filled(4),
      filled(5),
      filled(6)
    ]);
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [4],
        lastGridHex: Array.from({ length: 4 }, () => "0000").join("\n")
      })
    );

    const { tools } = buildArcGameTools(c);
    const long = await callTool(tools.arc_act, {
      steps: Array.from({ length: 6 }, () => ({ action: 4 }))
    });
    // floor(24/6) = 4 example cells per step.
    expect(long.split("\n")[1].match(/\(\d,\d\)/g)).toHaveLength(4);

    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({
        availableActions: [4],
        lastGridHex: Array.from({ length: 4 }, () => "0000").join("\n")
      })
    );
    const single = await callTool(tools.arc_act, { steps: [{ action: 4 }] });
    // A single step has the whole budget: 24, capped by the 16 cells that changed.
    expect(single.match(/\(\d,\d\)/g)).toHaveLength(16);
  });

  it("orients a fresh play with where the shapes are, not an order to go look", async () => {
    stubFetch({
      "/api/cmd/RESET": () =>
        FRAME({
          frame: [
            [
              [0, 0],
              [9, 9]
            ]
          ]
        })
    });
    const { ctx: c } = ctx();
    const { tools } = buildArcGameTools(c);

    const out = await callTool(tools.arc_reset_game, {});
    expect(out).toContain("blue: row 1, cols 0-1 (2 cells)");
    // The old text ended with "Call arc_inspect to see the board", which bought a
    // guaranteed second turn before the model could act.
    expect(out).not.toContain("Call arc_inspect");
  });

  it("names colors rather than indices in the inspect views", async () => {
    const { ctx: c } = ctx();
    await c.workspace.writeJson(
      "arc/session.json",
      SESSION({ lastGridHex: "9b\n00" })
    );

    const { tools } = buildArcGameTools(c);
    expect(await callTool(tools.arc_inspect, { view: "shapes" })).toContain(
      "blue: row 0, col 0 (1 cell)"
    );
    expect(await callTool(tools.arc_inspect, { view: "histogram" })).toContain(
      "white: 2 cells"
    );
    // The grid stays one character per cell — a legend carries the names instead.
    const grid = await callTool(tools.arc_inspect, { view: "grid" });
    expect(grid).toContain("colors: 0=white 9=blue b=yellow");
    expect(grid).toContain("| 9b");
  });
});
