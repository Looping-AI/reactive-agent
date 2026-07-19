import { tool } from "ai";
import { z } from "zod";
import type { ToolFamilyContext, RecipeToolSet } from "@/agent/tools";
import { makeArcClient } from "./client";
import {
  colorHistogram,
  connectedComponents,
  diffGrids,
  lastGrid,
  renderGridHex,
  renderRegion
} from "./analysis";
import {
  ARC_SESSION_PATH,
  type ArcSession,
  type FrameResponse,
  type GameInfo
} from "./types";

/**
 * The `arc-game` tool family: start / act / inspect against the ARC-AGI-3 REST
 * API. All durable session state (cookies, guid, card id, frames, metrics) lives
 * in the workspace at {@link ARC_SESSION_PATH}, so the run resumes across chunks
 * and isolate eviction. The API key is closed over from `env`, never model input.
 *
 * Transient ARC faults surface to the model as tool errors (the SDK captures a
 * throwing tool as an in-band `tool-error` result, not a rejected generation);
 * the soul tells the model to give up and report after repeated failures, and the
 * turn budget bounds it.
 */
export function buildArcGameTools(ctx: ToolFamilyContext): RecipeToolSet {
  const { workspace, env, emitProgress } = ctx;
  const client = makeArcClient(env.ARC_API_KEY);

  const load = (): Promise<ArcSession | null> =>
    workspace.readJson<ArcSession>(ARC_SESSION_PATH);
  const save = (s: ArcSession): Promise<void> =>
    workspace.writeJson(ARC_SESSION_PATH, s);

  const tools = {
    arc_start_game: tool({
      description:
        "Start playing an ARC-AGI-3 game. Call this exactly once, at the very beginning, with the game the user named.",
      inputSchema: z.object({
        game: z
          .string()
          .describe(
            "The game id or its prefix, e.g. 'ls20' or 'ls20-016295f7601e'"
          )
      }),
      execute: async ({ game }) => {
        const existing = await load();
        if (existing)
          return describeState(existing, "Game already in progress.");

        let cookies = {};
        const listed = await client.listGames(cookies);
        cookies = listed.cookies;
        const resolved = resolveGame(listed.games, game);
        if ("error" in resolved) return resolved.error;

        const opened = await client.openScorecard(cookies);
        cookies = opened.cookies;
        const reset = await client.reset(
          { gameId: resolved.game_id, cardId: opened.cardId },
          cookies
        );
        cookies = reset.cookies;

        const session = initialSession(
          resolved,
          opened.cardId,
          reset.frame,
          cookies
        );
        await save(session);
        return describeState(session, `Started ${resolved.game_id}.`);
      }
    }),

    arc_act: tool({
      description:
        "Take one action in the current game. Only use an action listed in the latest available_actions. Returns a compact outcome (cells changed, new level, new state, new available_actions).",
      inputSchema: z.object({
        action: z
          .number()
          .int()
          .min(1)
          .max(7)
          .describe(
            "1=up 2=down 3=left 4=right 5=interact 6=click(x,y) 7=undo"
          ),
        x: z
          .number()
          .int()
          .min(0)
          .max(63)
          .optional()
          .describe("column, action 6 only"),
        y: z
          .number()
          .int()
          .min(0)
          .max(63)
          .optional()
          .describe("row, action 6 only"),
        note: z
          .string()
          .max(2000)
          .optional()
          .describe("brief reasoning for this move")
      }),
      execute: async ({ action, x, y, note }) => {
        const session = await load();
        if (!session) return "No game in progress. Call arc_start_game first.";
        if (session.state === "WIN" || session.state === "GAME_OVER") {
          return `The game is over (state=${session.state}). Write your final report.`;
        }

        // Reconcile a possibly-interrupted prior action (crash between send and record).
        let recovery = "";
        if (session.pendingAction) {
          recovery =
            "\n(A previous action may have been interrupted and not recorded; the board may have advanced.)";
          session.pendingAction = null;
        }

        if (!session.availableActions.includes(action)) {
          return (
            `Action ${action} is not available. Available now: ${session.availableActions.join(", ")}.` +
            recovery
          );
        }
        if (action === 6 && (x === undefined || y === undefined)) {
          return "Action 6 (click) requires x and y (0–63)." + recovery;
        }

        // Write-ahead intent, then send, then record — the crash window is between.
        session.pendingAction = { action, x, y };
        await save(session);

        const { frame, cookies } = await client.act(
          { action, gameId: session.gameId, guid: session.guid, x, y, note },
          session.cookies
        );

        const before = session.lastFrame;
        const next = lastGrid(frame.frame);
        const diff = diffGrids(before, next);
        const prevLevel = session.levelsCompleted;

        session.cookies = cookies;
        session.guid = frame.guid;
        session.state = frame.state;
        session.levelsCompleted = frame.levels_completed;
        session.availableActions = frame.available_actions;
        if (frame.win_levels) session.winLevels = frame.win_levels;
        session.prevFrame = before;
        session.lastFrame = next;
        session.actionsSent++;
        session.pendingAction = null;

        if (
          frame.levels_completed > prevLevel &&
          !session.levelsReported.includes(frame.levels_completed)
        ) {
          session.levelsReported.push(frame.levels_completed);
          emitProgress({
            key: `arc:level:${frame.levels_completed}`,
            text:
              `ARC ${session.gameId}: reached level ${frame.levels_completed}` +
              `${session.winLevels ? `/${session.winLevels}` : ""} ` +
              `(${session.actionsSent} actions).`
          });
        }

        if (
          (session.state === "WIN" || session.state === "GAME_OVER") &&
          !session.scorecardClosed
        ) {
          await closeScorecard(client, session);
        }

        await save(session);
        return renderOutcome(session, diff) + recovery;
      }
    }),

    arc_inspect: tool({
      description:
        "Look at the current board without taking a game action. Views: 'grid' (full 64×64 hex), 'region' (a square around x,y), 'histogram' (color counts), 'shapes' (connected-component summary).",
      inputSchema: z.object({
        view: z.enum(["grid", "region", "histogram", "shapes"]),
        x: z.number().int().min(0).max(63).optional(),
        y: z.number().int().min(0).max(63).optional(),
        radius: z.number().int().min(1).max(20).optional()
      }),
      execute: async ({ view, x, y, radius }) => {
        const session = await load();
        if (!session || !session.lastFrame) return "No game in progress.";
        const grid = session.lastFrame;
        switch (view) {
          case "grid":
            return renderGridHex(grid);
          case "region":
            if (x === undefined || y === undefined)
              return "region view needs x and y.";
            return renderRegion(grid, y, x, radius);
          case "histogram":
            return colorHistogram(grid)
              .map((h) => `color ${h.color}: ${h.count} cells`)
              .join("\n");
          case "shapes":
            return connectedComponents(grid)
              .map(
                (s) =>
                  `color ${s.color}: ${s.components} shape(s), largest ${s.largest} cells`
              )
              .join("\n");
        }
      }
    })
  };

  const abort = async (c: ToolFamilyContext): Promise<void> => {
    const session = await c.workspace.readJson<ArcSession>(ARC_SESSION_PATH);
    if (!session || session.scorecardClosed || !session.cardId) return;
    await closeScorecard(makeArcClient(c.env.ARC_API_KEY), session);
    await c.workspace.writeJson(ARC_SESSION_PATH, session);
  };

  return { tools, abort };
}

/** Resolve a user-supplied game token to a single game, or a listing message. */
function resolveGame(
  games: GameInfo[],
  query: string
): GameInfo | { error: string } {
  const q = query.trim().toLowerCase();
  const listing = (): string =>
    "No unique match for that game. Available games:\n" +
    games
      .map((g) => `- ${g.game_id}${g.title ? ` (${g.title})` : ""}`)
      .join("\n") +
    "\nTell the user which games are available and stop.";
  if (q === "") return { error: listing() };

  // Tiers, most specific first: exact id, prefix-before-dash, generic prefix.
  const tiers = [
    games.filter((g) => g.game_id.toLowerCase() === q),
    games.filter((g) => g.game_id.toLowerCase().split("-")[0] === q),
    games.filter((g) => g.game_id.toLowerCase().startsWith(q))
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) return { error: listing() };
  }
  return { error: listing() };
}

function initialSession(
  game: GameInfo,
  cardId: string,
  frame: FrameResponse,
  cookies: Record<string, string>
): ArcSession {
  return {
    gameId: game.game_id,
    gameTitle: game.title ?? game.game_id,
    cardId,
    guid: frame.guid,
    cookies,
    winLevels: frame.win_levels ?? 0,
    levelsCompleted: frame.levels_completed,
    state: frame.state,
    availableActions: frame.available_actions,
    actionsSent: 0,
    levelsReported: [],
    lastFrame: lastGrid(frame.frame),
    prevFrame: null,
    pendingAction: null,
    scorecardClosed: false
  };
}

async function closeScorecard(
  client: ReturnType<typeof makeArcClient>,
  session: ArcSession
): Promise<void> {
  try {
    await client.closeScorecard(session.cardId, session.cookies);
  } catch {
    // Best-effort: an unclosed scorecard is a documented residual, not a failure.
  }
  session.scorecardClosed = true;
}

/** The compact per-action outcome the model reasons over (never the raw grid). */
function renderOutcome(
  session: ArcSession,
  diff: ReturnType<typeof diffGrids>
): string {
  const changed =
    diff.changed < 0
      ? "first frame"
      : diff.changed === 0
        ? "no cells changed"
        : `${diff.changed} cells changed` +
          (diff.cells.length > 0
            ? ` (e.g. ${diff.cells
                .slice(0, 6)
                .map((c) => `(${c.row},${c.col}) ${c.from}->${c.to}`)
                .join(", ")})`
            : "");
  return [
    changed,
    `level ${session.levelsCompleted}${session.winLevels ? `/${session.winLevels}` : ""}`,
    `state ${session.state}`,
    `available actions: ${session.availableActions.join(", ") || "none"}`
  ].join(" | ");
}

/** Full state summary used on start / re-entry. */
function describeState(session: ArcSession, prefix: string): string {
  return (
    `${prefix} ` +
    renderOutcome(session, { changed: -1, cells: [] }) +
    `. Call arc_inspect to see the board.`
  );
}
