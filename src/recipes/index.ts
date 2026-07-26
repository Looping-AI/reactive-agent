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

/**
 * The type a Subtask falls back to when code no longer knows the one on its row.
 * The delegate enum keeps unknown types out of *new* delegations, but a row
 * persisted before a type was renamed or retired must still be executable, and
 * the general recipe is the only one that can run work it knows nothing about.
 */
export const FALLBACK_TYPE_SPEC: SubtaskTypeSpec = GENERAL_SPEC;
