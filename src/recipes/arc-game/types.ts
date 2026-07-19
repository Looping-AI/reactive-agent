/**
 * ARC-AGI-3 REST API + session types. The API plays a visual-reasoning game on a
 * 64×64 grid of color values 0–15; see https://docs.arcprize.org. All state that
 * must survive across durable chunks (cookies, guid, card id, frames, metrics)
 * lives in the workspace as {@link ArcSession}, written by the tool family.
 */

/** Game lifecycle state as the API reports it. */
export type GameState = "NOT_STARTED" | "NOT_FINISHED" | "WIN" | "GAME_OVER";

/** Base URL of the ARC-AGI-3 API. */
export const ARC_BASE_URL = "https://three.arcprize.org";

/** One game as `GET /api/games` lists it. Ids look like `ls20-016295f7601e`. */
export interface GameInfo {
  game_id: string;
  title?: string;
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

/** Session-affinity cookie jar (AWSALB*), echoed on every request of a session. */
export type CookieJar = Record<string, string>;

/**
 * Durable game session, persisted to the workspace at {@link ARC_SESSION_PATH}.
 * The single grid we render/diff is the LAST grid of the frame array (the current
 * board); we keep the previous one for change detection.
 */
export interface ArcSession {
  gameId: string;
  gameTitle: string;
  cardId: string;
  guid: string;
  cookies: CookieJar;
  winLevels: number;
  levelsCompleted: number;
  state: GameState;
  availableActions: number[];
  /** Count of actions actually sent to the API (game moves). */
  actionsSent: number;
  /** Levels at which we have emitted a level-up progress note (dedupe within a run). */
  levelsReported: number[];
  lastFrame: number[][] | null;
  prevFrame: number[][] | null;
  /** Write-ahead intent: set before an action is sent, cleared after it returns. */
  pendingAction: { action: number; x?: number; y?: number } | null;
  /** Whether the scorecard has been closed (on WIN/GAME_OVER or cancellation). */
  scorecardClosed: boolean;
}

/** Workspace path for the durable ARC session. */
export const ARC_SESSION_PATH = "arc/session.json";
