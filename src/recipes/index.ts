import { GENERAL_SPEC } from "./general/recipe";
import { ARC_GAME_SPEC } from "./arc-game/recipe";
import type { SubtaskTypeSpec } from "./types";

/**
 * The Subtask type manifest: every type the main agent may delegate, each paired
 * with the Recipe it runs under, in the order the delegating model is shown them.
 *
 * This is the **only** place that knows the domains exist. Adding one is a new
 * folder under `src/recipes/` plus a line here — no edit anywhere in `agent/`,
 * which consumes this list and never names a domain. Order is deliberate:
 * general first, so the model reads the catch-all before the specialized types.
 */
export const SUBTASK_TYPE_SPECS: readonly SubtaskTypeSpec[] = [
  GENERAL_SPEC,
  ARC_GAME_SPEC
];
