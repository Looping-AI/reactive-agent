import { tool } from "ai";
import { z } from "zod";
import type { ToolFamilyContext, RecipeToolSet } from "@/agent/tools";
import { makeArcClient } from "./client";
import {
  colorHistogram,
  colorName,
  describeBox,
  describeCell,
  diffGrids,
  lastGrid,
  parseGrid,
  renderGrid,
  renderRegion,
  renderShapes,
  serializeGrid,
  type GridDiff
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
 * This family **plays**; it does not manage scorecards. The game arrives as a
 * validated Subtask param and the card as parent-resolved runtime (leased by
 * {@link file://./scorecard.ts}), so nothing here ever opens, closes, or chooses
 * a card. That is also why reaching WIN or GAME_OVER no longer ends anything: the
 * card outlives the play, and {@link ArcSession.plays} lets the model try again
 * on it.
 *
 * Transient ARC faults surface to the model as tool errors (the SDK captures a
 * throwing tool as an in-band `tool-error` result, not a rejected generation);
 * the soul tells the model to give up and report after repeated failures, and the
 * turn budget bounds it.
 */
/**
 * This family's key in a Recipe's `toolFamilies`. Exported because it is also
 * what tells the parent a Subtask needs a scorecard leased before it can run —
 * see `resolveRuntime` in the ReactiveAgent DO.
 */
export const ARC_GAME_FAMILY = "arc-game";

export function buildArcGameTools(ctx: ToolFamilyContext): RecipeToolSet {
  const { workspace, env, emitProgress, params, runtime } = ctx;
  const client = makeArcClient(env.ARC_API_KEY);

  // Both settled before the model runs — it cannot pick a different game, and it
  // cannot see, choose, or name a card at all. The game is the type's declared
  // param; the card is the lease the parent resolved for this chunk.
  const gameId = params.game_id;
  const cardId = runtime.cardId as string;

  const load = (): Promise<ArcSession | null> =>
    workspace.readJson<ArcSession>(ARC_SESSION_PATH);
  const save = (s: ArcSession): Promise<void> =>
    workspace.writeJson(ARC_SESSION_PATH, s);
  /** The stored board as a grid, or null when no frame has been recorded yet. */
  const board = (s: ArcSession): number[][] | null =>
    s.lastGridHex === null ? null : parseGrid(s.lastGridHex);

  const tools = {
    arc_reset_game: tool({
      description:
        "Start playing your assigned game. Call this first. Call it again after a WIN or GAME_OVER to play the same game once more on the same scorecard.",
      inputSchema: z.object({}),
      execute: async () => {
        const previous = await load();
        // Once a play has started, its own card wins over the current lease: a
        // lease that rolled over mid-execution must not strand this play's later
        // runs on a different card from its earlier ones.
        const playCardId = previous?.cardId ?? cardId;
        // The ARC API pins a scorecard to the session that opened it, so the
        // first RESET must present the jar the parent stored with the card;
        // afterwards this session's own jar carries the play forward.
        const { frame, cookies } = await client.reset(
          { gameId, cardId: playCardId },
          previous?.cookies ?? runtime.cookies ?? {}
        );
        const session = nextSession(
          previous,
          gameId,
          playCardId,
          frame,
          cookies
        );
        await save(session);
        const prefix =
          session.plays.length === 0
            ? `Started ${gameId}.`
            : `Restarted ${gameId} (play ${session.playIndex + 1}).`;
        return describeState(session, prefix);
      }
    }),

    arc_act: tool({
      description:
        "Take one or more actions in the current game, in order. Only use actions listed in the latest available_actions. Returns one diff per step — what each individual action changed — then the new level, state and available_actions. Batch only a movement you are confident about: every step is a real action counted against the game's baseline, so a wrong batch wastes score. While forming a hypothesis, send a single step.",
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
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
                .describe("row, action 6 only")
            })
          )
          .min(1)
          .max(MAX_STEPS)
          .describe(
            `the actions to take in order, 1–${MAX_STEPS}; each is sent separately and reported separately`
          ),
        note: z
          .string()
          .max(2000)
          .optional()
          .describe("brief reasoning for this move or sequence")
      }),
      execute: async ({ steps, note }) => {
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

        // Detail per step is budgeted across the sequence, so a long batch cannot
        // flood the context: a single step shows plenty, eight show a little each.
        const cellCap = Math.max(3, Math.floor(24 / steps.length));
        const trace: string[] = [];
        let sent = 0;
        let stopped: string | null = null;

        for (const [index, step] of steps.entries()) {
          const { action, x, y } = step;

          // Guard before sending: these are requests the API would reject or that
          // cannot mean anything, so spending an action on them is pure waste.
          if (!session.availableActions.includes(action)) {
            stopped =
              `${actionName(action)} is not available ` +
              `(available: ${session.availableActions.join(", ") || "none"})`;
          } else if (action === 6 && (x === undefined || y === undefined)) {
            stopped = "click (action 6) requires x and y (0–63)";
          }
          if (stopped) {
            trace.push(remaining(steps.length, index, stopped));
            break;
          }

          // Write-ahead intent, then send, then record — the crash window is
          // between, and it stays per-step so a crash mid-sequence is recoverable
          // exactly as a crash mid-action always was.
          session.pendingAction = { action, x, y };
          await save(session);

          const { frame, cookies } = await client.act(
            { action, gameId: session.gameId, guid: session.guid, x, y, note },
            session.cookies
          );

          // Diff against the board as it was immediately BEFORE this step, so each
          // line attributes its change to the one action that caused it. That
          // attribution is what makes batching safe: without it the model would see
          // that the board changed but not which action changed it.
          const before = board(session);
          const next = lastGrid(frame.frame);
          const diff = diffGrids(before, next, cellCap);
          const prevLevel = session.levelsCompleted;

          session.cookies = cookies;
          session.guid = frame.guid;
          session.state = frame.state;
          session.levelsCompleted = frame.levels_completed;
          session.availableActions = frame.available_actions;
          if (frame.win_levels) session.winLevels = frame.win_levels;
          session.lastGridHex = serializeGrid(next);
          session.actionsSent++;
          session.pendingAction = null;
          sent++;

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
          trace.push(
            `${index + 1}. ${actionName(action, x, y)} → ${renderDiff(diff)}`
          );

          // The play ended mid-sequence: anything after this would act on a
          // finished game.
          if (session.state === "WIN" || session.state === "GAME_OVER") {
            if (index + 1 < steps.length) {
              trace.push(
                remaining(
                  steps.length,
                  index + 1,
                  `state became ${session.state}`
                )
              );
            }
            break;
          }
        }

        const terminal =
          session.state === "WIN" || session.state === "GAME_OVER"
            ? "\nThis play is over — call arc_reset_game to play again, or write your final report."
            : "";
        const header =
          steps.length === 1
            ? ""
            : `${steps.length} steps requested, ${sent} sent.\n`;
        return (
          header +
          trace.join("\n") +
          "\n" +
          stateLine(session) +
          terminal +
          recovery
        );
      }
    }),

    arc_inspect: tool({
      description:
        "Look at the current board without taking a game action. Views: 'shapes' (every colored region with its row/column box — usually what you want, and far cheaper than the grid), 'region' (a labeled square around x,y), 'histogram' (how many cells of each color), 'grid' (the whole 64×64 board, one character per cell with a legend).",
      inputSchema: z.object({
        view: z.enum(["grid", "region", "histogram", "shapes"]),
        x: z.number().int().min(0).max(63).optional(),
        y: z.number().int().min(0).max(63).optional(),
        radius: z.number().int().min(1).max(20).optional()
      }),
      execute: async ({ view, x, y, radius }) => {
        const session = await load();
        const grid = session === null ? null : board(session);
        if (grid === null) return "No game in progress.";
        switch (view) {
          case "grid":
            return renderGrid(grid);
          case "region":
            if (x === undefined || y === undefined)
              return "region view needs x and y.";
            return renderRegion(grid, y, x, radius);
          case "histogram":
            return colorHistogram(grid)
              .map((h) => `${colorName(h.color)}: ${h.count} cells`)
              .join("\n");
          case "shapes":
            return renderShapes(grid);
        }
      }
    })
  };

  // No `abort` hook: the only external state this family used to hold was the
  // scorecard, and nothing closes one any more — the API retires an idle card on
  // its own. A play left unfinished is simply a run the card records as
  // incomplete.
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
    lastGridHex: serializeGrid(lastGrid(frame.frame)),
    pendingAction: null
  };
}

/** Human names for the seven actions, so results read as moves not opcodes. */
const ACTION_NAMES: Record<number, string> = {
  1: "up",
  2: "down",
  3: "left",
  4: "right",
  5: "interact",
  6: "click",
  7: "undo"
};

/** How many actions one `arc_act` call may carry. */
const MAX_STEPS = 8;

function actionName(action: number, x?: number, y?: number): string {
  const name = ACTION_NAMES[action] ?? `action ${action}`;
  return action === 6 && x !== undefined && y !== undefined
    ? `${name}(${x},${y})`
    : name;
}

/** "5-8. not sent: <why>" — an aborted tail, named so it is never assumed to have run. */
function remaining(total: number, from: number, why: string): string {
  const label = from + 1 === total ? `${total}.` : `${from + 1}-${total}.`;
  return `${label} not sent: ${why}`;
}

/**
 * What one action did: how much changed, where, and which colors — the causal
 * signal the model refines its hypothesis from.
 */
function renderDiff(diff: GridDiff): string {
  if (diff.changed < 0) return "first frame";
  // A no-op is information, not an absence of it: it usually means blocked.
  if (diff.changed === 0) return "0 cells changed (no effect)";
  const where = diff.box === null ? "" : `, ${describeBox(diff.box)}`;
  const examples =
    diff.cells.length === 0
      ? ""
      : ` (${diff.cells.length < diff.changed ? "e.g. " : ""}` +
        `${diff.cells.map(describeCell).join(", ")})`;
  return `${diff.changed} cells changed${where}${examples}`;
}

/** Level / state / legal-actions — the board-independent status, one line. */
function stateLine(session: ArcSession): string {
  return [
    `level ${session.levelsCompleted}${session.winLevels ? `/${session.winLevels}` : ""}`,
    `state ${session.state}`,
    `available actions: ${session.availableActions.join(", ") || "none"}`
  ].join(" | ");
}

/**
 * Full summary used on start / re-entry, including where every shape is. Orienting
 * the model here is what lets a reset cost one turn instead of two: the old text
 * told it to call `arc_inspect` next, which guaranteed a second turn before it
 * could act.
 */
function describeState(session: ArcSession, prefix: string): string {
  const grid =
    session.lastGridHex === null ? null : parseGrid(session.lastGridHex);
  const shapes = grid === null ? "" : `\nBoard:\n${renderShapes(grid)}`;
  return `${prefix} ${stateLine(session)}${shapes}`;
}
