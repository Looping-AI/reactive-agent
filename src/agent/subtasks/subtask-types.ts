import { SUBTASK_TYPE_SPECS } from "@/recipes";
import type {
  ResolvedRecipe,
  SubtaskParams,
  SubtaskTypeSpec
} from "@/recipes/types";

/**
 * The **closed set of Subtask types** the main agent may delegate, as the agent
 * uses it: lookup, the delegate enum, param validation, and the catalogue the
 * delegating model is shown.
 *
 * The set itself is not declared here. Each domain declares its own type and the
 * Recipe it runs under, and {@link file://../../recipes/index.ts} collects them —
 * so this module names no domain, and adding one never touches `agent/`. What
 * lives here is only what is true of *every* type.
 */

export type { SubtaskParams, SubtaskTypeSpec };

/** Every known type, keyed by its `key`. */
export const SUBTASK_TYPES: ReadonlyMap<string, SubtaskTypeSpec> = new Map(
  SUBTASK_TYPE_SPECS.map((spec) => [spec.key, spec])
);

/**
 * The type keys as a non-empty tuple, for `z.enum` in the delegate schema — the
 * model cannot emit anything outside it, so an unknown type never reaches the
 * data layer.
 */
export const SUBTASK_TYPE_KEYS = SUBTASK_TYPE_SPECS.map((s) => s.key) as [
  string,
  ...string[]
];

/** Look up a type, or null when it is not one we know. */
export function subtaskTypeSpec(type: string): SubtaskTypeSpec | null {
  return SUBTASK_TYPES.get(type) ?? null;
}

/**
 * Resolve a Subtask type to the Recipe it runs under. Throws
 * {@link SubtaskParamsError} for an unknown or retired type — the delegate
 * enum prevents the model from emitting one, so any unknown type reaching
 * execution is a configuration bug and should fail terminally.
 */
export function resolveRecipeForType(type: string): ResolvedRecipe {
  const spec = subtaskTypeSpec(type);
  if (!spec) throw new SubtaskParamsError(`unknown subtask type: ${type}`);
  return spec.recipe;
}

/** A Subtask whose params do not satisfy its type's contract. */
export class SubtaskParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtaskParamsError";
  }
}

/**
 * Validate a Subtask's params against its type's contract, returning the params
 * to persist. A type with no schema must carry no params — a stray param would
 * otherwise ride along unread, looking meaningful.
 *
 * Shape only: whether `card_id` names a scorecard that actually exists and is
 * still open is a question for durable rows, answered when the execution starts.
 */
export function validateSubtaskParams(
  type: string,
  params: SubtaskParams | undefined
): SubtaskParams {
  const spec = subtaskTypeSpec(type);
  if (!spec) throw new SubtaskParamsError(`unknown subtask type: ${type}`);

  const supplied = params ?? {};
  if (!spec.params) {
    const extra = Object.keys(supplied);
    if (extra.length > 0) {
      throw new SubtaskParamsError(
        `subtask type "${type}" takes no params, got: ${extra.join(", ")}`
      );
    }
    return {};
  }

  const parsed = spec.params.safeParse(supplied);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new SubtaskParamsError(
      `subtask type "${type}" has invalid params — ${detail}`
    );
  }
  return parsed.data;
}

/** The type catalogue as the delegating model is shown it. */
export function renderSubtaskTypes(): string {
  return SUBTASK_TYPE_SPECS.map((spec) => {
    const help = spec.paramsHelp ? ` — ${spec.paramsHelp}` : "";
    return `- \`${spec.key}\`: ${spec.description}${help}`;
  }).join("\n");
}
