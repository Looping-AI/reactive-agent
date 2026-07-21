import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import type { ResolvedRecipe } from "@/agent/subtasks/types";
import { ARC_GAME_SOUL } from "./soul";

/** Semantic Subtask type the decomposer emits for a "play this game" request. */
export const ARC_GAME_TYPE = "arc-game";

/**
 * Recipe for playing an ARC-AGI-3 game. Runs on the repo's default model pair,
 * but — unlike the default recipe — it is a **long, resumable** execution:
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
