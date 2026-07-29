import { z } from "zod";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import type { ResolvedRecipe, SubtaskTypeSpec } from "@/recipes/types";
import { ARC_GAME_SOUL } from "./soul";

/** Semantic Subtask type the decomposer emits for a "play this game" request. */
export const ARC_GAME_TYPE = "arc-game";

/**
 * Recipe for playing an ARC-AGI-3 game. Runs on the repo's default model pair and
 * the baseline budget; what distinguishes it is its tool families, its soul, and
 * its context discipline — not its limits.
 *
 * It used to be "the long recipe", budgeted at 1,000 turns on the reasoning that
 * 25 turns per chunk made 40 durable chunks. That arithmetic assumed a turn under
 * ten seconds. A turn here is a reasoning model plus an ARC HTTP round trip, so
 * real runs took 70-100 chunks, blew the per-branch cap, and were *failed* after
 * hours of unattended play rather than being asked to report. The budget is now
 * time and turns, both enforced directly, and a play ends through the graceful
 * summary — a terminal report with the metrics footer.
 *
 * - `historyWindow` is small: the model keeps only recent turns in context and
 *   persists durable state (rules, plans) to the workspace instead (see the
 *   memory discipline in {@link ARC_GAME_SOUL}). Note it counts *assistant
 *   messages* — one per tool call, not one per game action — so a play spends it
 *   several times faster than the number suggests.
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
  // The baseline. A game would happily use more, which is exactly why the number
  // is not the game's to choose.
  limits: {},
  // Counts assistant messages (tool calls), so an inspect + act + note cycle spends
  // three or four of these per game action; 12 left the model unable to see more
  // than a couple of moves back, which it answered by re-inspecting.
  historyWindow: 24,
  reportMetrics: true
};

/**
 * The arc-game type. Its one param is an id the model quotes back from a tool
 * result it already saw, so the contract is checkable before anything runs: a
 * play with no game cannot succeed, and refusing it here costs no model call.
 *
 * There is deliberately no `card_id`. Which scorecard a play runs on is not a
 * choice — the API auto-closes an idle card, so the live card is whichever one
 * was used recently — and the parent leases it per chunk (see
 * {@link file://./scorecard.ts}), handing it to the execution as runtime state.
 */
export const ARC_GAME_SPEC: SubtaskTypeSpec = {
  key: ARC_GAME_TYPE,
  description: "Play one ARC-AGI-3 game.",
  params: z.object({
    game_id: z.string().min(1).describe("An exact game id from arc_list_games")
  }),
  paramsHelp: "requires param `game_id` (an exact id from `arc_list_games`)",
  recipe: ARC_GAME_RECIPE
};
