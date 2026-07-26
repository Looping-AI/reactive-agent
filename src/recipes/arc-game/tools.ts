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
  type PlaySummary
} from "./types";

/**
 * The `arc-game` tool family: reset / act / inspect against the ARC-AGI-3 REST
 * API. All durable session state (cookies, guid, frames, metrics) lives in the
 * workspace at {@link ARC_SESSION_PATH}, so the run resumes across chunks and
 * isolate eviction. The API key is closed over from `env`, never model input.
 *
 * This family **plays**; it does not manage scorecards. The card is opened and
 * closed by the main agent (`arc_open_scorecard` / `arc_close_scorecard`), which
 * names it in this subtask's prompt — so `card_id` and `game_id` arrive as tool
 * input, and nothing here ever opens, closes, or chooses a card. That is also why
 * reaching WIN or GAME_OVER no longer ends anything: the card outlives the play,
 * and {@link ArcSession.plays} lets the model try again on it.
 *
 * Transient ARC faults surface to the model as tool errors (the SDK captures a
 * throwing tool as an in-band `tool-error` result, not a rejected generation);
 * the soul tells the model to give up and report after repeated failures, and the
 * turn budget bounds it.
 */
export function buildArcGameTools(ctx: ToolFamilyContext): RecipeToolSet {
  const { workspace, env, emitProgress, params, runtime } = ctx;
  const client = makeArcClient(env.ARC_API_KEY);

  // The subtask type declares both of these, so they are settled before the
  // model runs — it cannot pick a different game or play on someone else's card.
  const gameId = params.game_id;
  const cardId = params.card_id;

  const load = (): Promise<ArcSession | null> =>
    workspace.readJson<ArcSession>(ARC_SESSION_PATH);
  const save = (s: ArcSession): Promise<void> =>
    workspace.writeJson(ARC_SESSION_PATH, s);

  const tools = {
    arc_reset_game: tool({
      description:
        "Start playing your assigned game. Call this first. Call it again after a WIN or GAME_OVER to play the same game once more on the same scorecard.",
      inputSchema: z.object({}),
      execute: async () => {
        const previous = await load();
        // The ARC API pins a scorecard to the session that opened it, so the
        // first RESET must present the jar the parent stored with the card;
        // afterwards this session's own jar carries the play forward.
        const { frame, cookies } = await client.reset(
          { gameId, cardId },
          previous?.cookies ?? runtime.cookies ?? {}
        );
        const session = nextSession(previous, gameId, cardId, frame, cookies);
        await save(session);
        const prefix =
          session.plays.length === 0
            ? `Started ${gameId} on scorecard ${cardId}.`
            : `Restarted ${gameId} (play ${session.playIndex + 1}) on scorecard ${cardId}.`;
        return describeState(session, prefix);
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
        if (!session) return "No game in progress. Call arc_reset_game first.";
        if (session.state === "WIN" || session.state === "GAME_OVER") {
          return (
            `This play is over (state=${session.state}). ` +
            "Call arc_reset_game to play again on the same scorecard, or write your final report."
          );
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
            // Keyed per play: the same level reached on a later attempt is a
            // genuinely new note, and the gateway dedupes on this key.
            key: `arc:${session.gameId}:play${session.playIndex}:level:${frame.levels_completed}`,
            text:
              `ARC ${session.gameId}: reached level ${frame.levels_completed}` +
              `${session.winLevels ? `/${session.winLevels}` : ""} ` +
              `(${session.actionsSent} actions` +
              `${session.playIndex > 0 ? `, play ${session.playIndex + 1}` : ""}).`
          });
        }

        await save(session);

        const terminal =
          session.state === "WIN" || session.state === "GAME_OVER"
            ? " | this play is over — call arc_reset_game to play again, or write your final report"
            : "";
        return renderOutcome(session, diff) + terminal + recovery;
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

  // No `abort` hook: the only external state this family used to hold was the
  // scorecard, and that now belongs to the main agent. A play left unfinished is
  // simply a run the card records as incomplete.
  return { tools };
}

/**
 * The session after a RESET: a fresh play, with any previous one archived into
 * `plays` so the final report can account for every attempt. Per-play counters
 * (`actionsSent`, `levelsReported`) start over; the cookie jar and the history of
 * plays carry forward.
 */
function nextSession(
  previous: ArcSession | null,
  gameId: string,
  cardId: string,
  frame: FrameResponse,
  cookies: Record<string, string>
): ArcSession {
  const plays: PlaySummary[] = previous ? [...previous.plays] : [];
  if (previous) {
    plays.push({
      gameId: previous.gameId,
      guid: previous.guid,
      state: previous.state,
      levelsCompleted: previous.levelsCompleted,
      actionsSent: previous.actionsSent
    });
  }
  return {
    cardId,
    gameId,
    guid: frame.guid,
    cookies,
    winLevels: frame.win_levels ?? 0,
    levelsCompleted: frame.levels_completed,
    state: frame.state,
    availableActions: frame.available_actions,
    actionsSent: 0,
    playIndex: plays.length,
    plays,
    levelsReported: [],
    lastFrame: lastGrid(frame.frame),
    prevFrame: null,
    pendingAction: null
  };
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
