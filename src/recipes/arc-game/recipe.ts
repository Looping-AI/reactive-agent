import { z } from "zod";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import type { ResolvedRecipe, SubtaskTypeSpec } from "@/recipes/types";
import { ARC_GAME_SOUL } from "./soul";

/** Semantic Subtask type the decomposer emits for a "play this game" request. */
export const ARC_GAME_TYPE = "arc-game";

/**
 * Recipe for playing an ARC-AGI-3 game. Runs on the repo's default model pair,
 * but — unlike the general recipe — it is a **long, resumable** execution:
 *
 * - `maxTurns` far exceeds `turnsPerChunk`, so the run spans many durable
 *   Workflow chunks (each a fresh, retryable step well under the ~10-min step
 *   timeout) rather than one bounded call.
 * - `chunkSoftMs` ends a chunk early on wall-clock, keeping every step short.
 * - `historyWindow` is small: the model keeps only recent turns in context and
 *   persists durable state (rules, plans) to the workspace instead (see the
 *   memory discipline in {@link ARC_GAME_SOUL}).
 * - `reportMetrics` appends the turns/model-calls/wall-clock footer the user
 *   asked to see.
 *
 * Tool families: `workspace` (the model's durable file store) and `arc-game`
 * (start/act/inspect against the ARC REST API, session state kept in the
 * workspace). Both are code-validated by `validateRecipe`/`buildRecipeTools`.
 */
export const ARC_GAME_RECIPE: ResolvedRecipe = {
  key: ARC_GAME_TYPE,
  version: 1,
  primaryModelId: CHAT_MODEL_ID,
  fallbackModelId: CHAT_FALLBACK_MODEL_ID,
  soul: ARC_GAME_SOUL,
  toolFamilies: ["workspace", "arc-game"],
  enabled: true,
  // Long, but deliberately bounded: 1k turns → terminal "budget exhausted" with
  // full metrics. 25 turns/chunk keeps a chunk well under the step timeout, and
  // the resulting 40 nominal chunks sit inside `MAX_CHUNKS_PER_BRANCH` (80) with
  // room for the level-up progress events that end a chunk early.
  limits: {
    maxTurns: 1_000,
    turnsPerChunk: 25,
    chunkSoftMs: 4 * 60_000
  },
  historyWindow: 12,
  reportMetrics: true
};

/**
 * The arc-game type. Both params are ids the model quotes back from a tool result
 * it already saw, so the contract is checkable before anything runs: a play with
 * no scorecard or no game cannot succeed, and refusing it here costs no model
 * call. The API session pinned to `card_id` is resolved by the parent from the id
 * — never carried here.
 */
export const ARC_GAME_SPEC: SubtaskTypeSpec = {
  key: ARC_GAME_TYPE,
  description: "Play one ARC-AGI-3 game on one of your open scorecards.",
  params: z.object({
    card_id: z
      .string()
      .min(1)
      .describe("A scorecard card id you opened with arc_open_scorecard"),
    game_id: z.string().min(1).describe("An exact game id from arc_list_games")
  }),
  paramsHelp:
    "requires params `card_id` (from `arc_open_scorecard`) and `game_id` (from `arc_list_games`)",
  recipe: ARC_GAME_RECIPE
};
