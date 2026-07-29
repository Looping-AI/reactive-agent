/**
 * ARC-AGI-3 REST API + session types. The API plays a visual-reasoning game on a
 * 64×64 grid of color values 0–15; see https://docs.arcprize.org.
 *
 * Two lifecycles meet here, and neither belongs to a model:
 *
 * - The **scorecard** is a container that aggregates many plays. The API opens
 *   one on request and auto-closes it after ~15 minutes idle, so nothing here
 *   ever closes one: the parent leases the most recently used card and records it
 *   in its DO SQLite (`db.scorecards`) purely to know how fresh it is.
 * - A **play** is one RESET→ACTION* run inside a scorecard, driven by a subagent.
 *   All state that must survive across durable chunks (cookies, guid, frames,
 *   metrics) lives in the workspace as {@link ArcSession}, written by the tool
 *   family. A subagent is handed a resolved card; it never opens or chooses one.
 */

/** Game lifecycle state as the API reports it. */
export type GameState = "NOT_STARTED" | "NOT_FINISHED" | "WIN" | "GAME_OVER";

/** Base URL of the ARC-AGI-3 API. */
export const ARC_BASE_URL = "https://three.arcprize.org";

/**
 * One game as `GET /api/games` lists it. Ids look like `ls20-016295f7601e`.
 * `tags` describes how it is played (`click`, `keyboard`, `keyboard_click`) and
 * `baseline_actions` is the per-level human baseline — both are shown to the
 * main agent so it can brief a play sensibly.
 */
export interface GameInfo {
  game_id: string;
  title?: string;
  tags?: string[];
  baseline_actions?: number[];
}

/** A frame response from RESET / ACTION*. `frame` is one or more 64×64 grids. */
export interface FrameResponse {
  game_id: string;
  guid: string;
  frame: number[][][];
  state: GameState;
  levels_completed: number;
  win_levels?: number;
  available_actions: number[];
  score?: number;
}

/** One RESET→terminal run of a game, as the scorecard reports it. */
export interface ScorecardRun {
  guid: string;
  actions: number;
  completed: boolean;
  levels_completed: number;
  resets: number;
  score: number;
  state: GameState;
  /** Actions spent on each level of this run. */
  level_actions?: number[];
  /** The human baseline each level is scored against. */
  level_baseline_actions?: number[];
  level_scores?: number[];
}

/**
 * One game's aggregate within a scorecard — every run played against it.
 *
 * This is the **only** game-scoped part of the response: every top-level field of
 * {@link ScorecardSummary} covers the whole card. Since several games share one
 * card by design, reporting a card-level total as a game's own is a real
 * mislabeling — so the renderer reads nothing but this entry.
 */
export interface ScorecardEnvironment {
  id: string;
  actions: number;
  completed: boolean;
  level_count: number;
  levels_completed: number;
  resets: number;
  score: number;
  runs: ScorecardRun[];
}

/** Per-tag rollup (`click`, `keyboard`, …) across the scorecard's games. */
export interface ScorecardTagScore {
  id: string;
  actions: number;
  levels_completed: number;
  number_of_environments: number;
  number_of_levels: number;
  score: number;
}

/**
 * A whole scorecard as `GET /api/scorecard/{card_id}` reports it: one
 * `environments` entry per game played, one `runs` entry per RESET within it.
 *
 * This is a **read**, not a terminal event — it works while the card is still
 * open, which is what lets a result be reported without anything ever closing a
 * card. (It is the same shape the retired close call returned, which is why it
 * carries a real per-game `score`.)
 *
 * The narrower `GET /api/scorecard/{card_id}/{game_id}` is deliberately *not*
 * used: it reports no score at all, and its top-level totals are card-wide
 * despite the game filter — verified against the live API.
 */
export interface ScorecardSummary {
  card_id: string;
  score: number;
  total_actions: number;
  total_environments: number;
  total_environments_completed: number;
  total_levels: number;
  total_levels_completed: number;
  environments: ScorecardEnvironment[];
  tags?: string[];
  tags_scores?: ScorecardTagScore[];
}

/**
 * One scorecard as the agent's DO SQLite records it (see `db/schema.ts`).
 *
 * There is no status: the API auto-closes an idle card, so liveness is inferred
 * from {@link lastUsedAt} rather than tracked. A card is a lease, not an object
 * with a lifecycle.
 */
export interface Scorecard {
  cardId: string;
  /**
   * The jar `POST /api/scorecard/open` returned. The API pins the card to that
   * session — every later RESET, ACTION, and scorecard read must echo these
   * cookies, from whichever agent makes the call — so it is stored with the card,
   * not held by whoever happened to open it.
   */
  cookies: CookieJar;
  openedAt: number;
  /** Last time a play resolved onto this card; the reuse clock. */
  lastUsedAt: number;
}

/** Session-affinity cookie jar (AWSALB*), echoed on every request of a session. */
export type CookieJar = Record<string, string>;

/** A finished play, kept so the final report can account for every attempt. */
export interface PlaySummary {
  gameId: string;
  guid: string;
  state: GameState;
  levelsCompleted: number;
  actionsSent: number;
}

/**
 * Durable play session, persisted to the workspace at {@link ARC_SESSION_PATH}.
 * The single grid we render/diff is the LAST grid of the frame array (the current
 * board).
 *
 * One session file spans the whole execution, not one play: reaching WIN or
 * GAME_OVER no longer ends anything, so `arc_reset_game` may be called again to
 * play once more on the same scorecard. Each finished play is archived into
 * {@link plays} first, and `playIndex` keeps per-play progress keys distinct.
 */
export interface ArcSession {
  /**
   * The scorecard this session plays on, pinned at the first RESET from the card
   * the parent resolved. Pinned rather than re-read each chunk: if the lease rolls
   * over onto a new card mid-execution, this play must finish on the card its
   * runs already belong to.
   */
  cardId: string;
  gameId: string;
  guid: string;
  cookies: CookieJar;
  winLevels: number;
  levelsCompleted: number;
  state: GameState;
  availableActions: number[];
  /** Count of actions actually sent to the API (game moves) in the current play. */
  actionsSent: number;
  /** 0-based index of the current play; increments on every re-RESET. */
  playIndex: number;
  /** Plays already finished in this execution, oldest first. */
  plays: PlaySummary[];
  /** Levels at which we have emitted a level-up progress note (per play). */
  levelsReported: number[];
  /**
   * The current board as bare hex rows (`serializeGrid`), not `number[][]`.
   *
   * The workspace pretty-prints its JSON, so a nested numeric array serializes to
   * one integer per line — ~38 KB for a 64×64 board. Since the session is written
   * twice per action (write-ahead intent, then the recorded result) and one
   * `arc_act` call may now carry several actions, that adds up to hundreds of KB of
   * SQLite per tool call. Hex rows are ~4 KB.
   */
  lastGridHex: string | null;
  /** Write-ahead intent: set before an action is sent, cleared after it returns. */
  pendingAction: { action: number; x?: number; y?: number } | null;
}

/** Workspace path for the durable ARC session. */
export const ARC_SESSION_PATH = "arc/session.json";
