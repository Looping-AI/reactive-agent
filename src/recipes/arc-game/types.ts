/**
 * ARC-AGI-3 REST API + session types. The API plays a visual-reasoning game on a
 * 64×64 grid of color values 0–15; see https://docs.arcprize.org.
 *
 * Two lifecycles meet here, and they are owned by different agents:
 *
 * - The **scorecard** is a container that aggregates many plays, opened and
 *   closed by the main agent and recorded in its DO SQLite (`db.scorecards`).
 *   Its terminal {@link ScorecardSummary} is the score the user is told.
 * - A **play** is one RESET→ACTION* run inside a scorecard, driven by a subagent.
 *   All state that must survive across durable chunks (cookies, guid, frames,
 *   metrics) lives in the workspace as {@link ArcSession}, written by the tool
 *   family. A subagent is told its `card_id` in its prompt; it never opens or
 *   closes one.
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
  level_actions?: number[];
  level_baseline_actions?: number[];
  level_scores?: number[];
}

/** One game's aggregate within a scorecard — every run played against it. */
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
 * The body `POST /api/scorecard/close` returns: the whole card's result, one
 * `environments` entry per game played and one `runs` entry per RESET within it.
 * There is no endpoint to re-read a closed card, so this is persisted verbatim on
 * the scorecard row and is the only lasting record of a score.
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

/** Whether a scorecard is still accepting plays. */
export type ScorecardStatus = "open" | "closed";

/**
 * One scorecard as the main agent's DO SQLite records it (see `db/schema.ts`).
 * `summary` is null until the card is closed, and is the persisted
 * {@link ScorecardSummary} thereafter.
 */
export interface Scorecard {
  cardId: string;
  status: ScorecardStatus;
  /**
   * The jar `POST /api/scorecard/open` returned. The API pins the card to that
   * session — every later RESET, ACTION, and close must echo these cookies, from
   * whichever agent makes the call — so it is stored with the card, not held by
   * whoever happened to open it.
   */
  cookies: CookieJar;
  openedAt: number;
  closedAt: number | null;
  summary: ScorecardSummary | null;
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
 * board); we keep the previous one for change detection.
 *
 * One session file spans the whole execution, not one play: reaching WIN or
 * GAME_OVER no longer ends anything, so `arc_reset_game` may be called again to
 * play once more on the same scorecard. Each finished play is archived into
 * {@link plays} first, and `playIndex` keeps per-play progress keys distinct.
 */
export interface ArcSession {
  /** The scorecard this session plays on, as the subagent was told in its prompt. */
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
  lastFrame: number[][] | null;
  prevFrame: number[][] | null;
  /** Write-ahead intent: set before an action is sent, cleared after it returns. */
  pendingAction: { action: number; x?: number; y?: number } | null;
}

/** Workspace path for the durable ARC session. */
export const ARC_SESSION_PATH = "arc/session.json";
