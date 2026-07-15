export type SubtaskStatus =
  "pending" | "running" | "completed" | "failed" | "skipped" | "canceled";

/** A per-caller, SQLite-assigned, monotonically increasing Subtask identifier. */
export type SubtaskId = number;

/**
 * An exact, verbatim snapshot of one selected Session history message, copied
 * onto the Subtask at decomposition time. The decomposition model selects which
 * messages to reference; it never rewrites their content. User-turn provenance
 * (author/channel) is already inline in the message text's `<turn>` wrapper.
 */
export interface SubtaskReference {
  role: "user" | "assistant";
  text: string;
}

/**
 * One part of a Subtask's result. Text-only today; file/data kinds are additive
 * later. Internal to the agent — the terminal A2A Task collapses these to a
 * single text reply for the gateway/human.
 */
export interface SubtaskResultPart {
  kind: "text";
  text: string;
}

/**
 * Creation input for one Subtask, before it is persisted. `dependsOn` uses
 * draft-local keys (not yet-unknown {@link SubtaskId}s); the data layer resolves
 * them to SQLite-assigned ids when the decomposition is created. `ordinal` is
 * derived from the draft's position in the decomposition array.
 */
export interface SubtaskDraft {
  localKey: string;
  type: string;
  prompt: string;
  references: SubtaskReference[];
  /** Draft-local keys of prerequisite drafts. */
  dependsOn: string[];
}

/**
 * A fully-resolved Recipe configuration handed to a subagent invocation. Today
 * this is always the code-owned `DEFAULT_RECIPE` (see `agent/subtasks/recipe.ts`);
 * caller-local DB rows mapping into this shape are deferred until a Recipe
 * admin surface exists. Model ids and tool families remain code-validated
 * downstream (`validateRecipe`).
 */
export interface ResolvedRecipe {
  key: string;
  version: number;
  primaryModelId: string;
  fallbackModelId: string;
  soul: string;
  toolFamilies: string[];
  enabled: boolean;
}

/**
 * Generated output of one completed prerequisite Subtask, loaded by the parent
 * from its durable row for a dependent's invocation. `type` is the
 * prerequisite's semantic type — used only to label the rendered section;
 * dependency output is always presented as generated, never as conversation
 * evidence.
 */
export interface DependencyResult {
  subtaskId: SubtaskId;
  type: string;
  resultParts: SubtaskResultPart[];
}

/**
 * RPC-safe input for one isolated `RecipeSubagent` execution, assembled by the
 * parent at execution start: the already-resolved (and code-validated) Recipe,
 * the Subtask's non-session prompt, its verbatim reference snapshots, and the
 * generated results of its completed dependencies. The child re-validates the
 * Recipe defensively but never resolves one itself.
 */
export interface RecipeExecutionRequest {
  taskId: string;
  subtaskId: SubtaskId;
  recipe: ResolvedRecipe;
  prompt: string;
  references: SubtaskReference[];
  dependencyResults: DependencyResult[];
}

/**
 * Terminal outcome of one `RecipeSubagent` execution (RPC-safe). `modelId` is a
 * diagnostic only — which model produced the outcome (null when validation
 * failed before any model call); it is never persisted on the Subtask row.
 * Transient platform faults are not results: they throw so the enclosing
 * Workflow step can retry.
 */
export type RecipeExecutionResult =
  | { status: "completed"; resultParts: SubtaskResultPart[]; modelId: string }
  | { status: "failed"; error: string; modelId: string | null };

/** Durable state owned by the main agent for one decomposed unit of work. */
export interface Subtask {
  id: SubtaskId;
  taskId: string;
  ordinal: number;
  type: string;
  recipeId: string | null;
  recipeVersion: number | null;
  prompt: string;
  references: SubtaskReference[];
  dependsOn: SubtaskId[];
  status: SubtaskStatus;
  resultParts: SubtaskResultPart[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
