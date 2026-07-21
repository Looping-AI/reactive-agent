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
 * Execution budget for one Recipe, enforced by the resumable runner (not the
 * Workflow). The runner drives the model/tool loop in durable **chunks**: it runs
 * up to `turnsPerChunk` turns (or `chunkSoftMs` wall-clock, whichever first) per
 * Workflow step, checkpoints, and yields for a fresh step — so a long run never
 * exceeds the platform's per-step timeout. `maxTurns` is the whole-execution
 * ceiling across every chunk. The default recipe sets `maxTurns === turnsPerChunk`
 * so it always finishes in one chunk.
 */
export interface RecipeLimits {
  /** Whole-execution ceiling on model turns (one turn = one tool-loop step). */
  maxTurns: number;
  /** Turns to run within a single durable chunk before yielding a fresh step. */
  turnsPerChunk: number;
  /** Soft wall-clock budget (ms) per chunk; ends a chunk early to stay under the step timeout. */
  chunkSoftMs: number;
}

/**
 * A fully-resolved Recipe configuration handed to a subagent invocation. Today
 * these are code-owned constants (see `agent/subtasks/registry.ts` and
 * `recipes/<domain>/recipe.ts`); caller-local DB rows mapping into this shape are
 * deferred until a Recipe admin surface exists. Model ids, tool families, and
 * limits remain code-validated downstream (`validateRecipe`).
 */
export interface ResolvedRecipe {
  key: string;
  version: number;
  primaryModelId: string;
  fallbackModelId: string;
  soul: string;
  toolFamilies: string[];
  enabled: boolean;
  /** Turn/chunk/time budget the resumable runner enforces. */
  limits: RecipeLimits;
  /** Most-recent turns kept verbatim in the rolling model context; older turns are pruned. */
  historyWindow: number;
  /** Append a runtime metrics footer (turns, model calls, wall-clock) to the final result. */
  reportMetrics: boolean;
}

/**
 * A user-facing progress note a tool emits mid-execution (e.g. a game level-up).
 * The resumable runner collects these and ends the current chunk so the parent
 * DO can post them promptly; `key` is a stable dedupe id the gateway keys on.
 */
export interface ProgressEvent {
  key: string;
  text: string;
}

/**
 * One durable chunk's outcome as the facet reports it to the parent DO. `done`
 * false means the run yielded a chunk boundary and the Workflow must run another
 * chunk; `done` true carries the terminal {@link RecipeExecutionResult}. Progress
 * events accumulated during the chunk ride along either way.
 */
export type RecipeChunkResult =
  | { done: false; progress: ProgressEvent[] }
  | { done: true; result: RecipeExecutionResult; progress: ProgressEvent[] };

/**
 * The parent DO's projection of a chunk outcome for the Workflow (RPC-safe, no
 * result parts — those are persisted on the row). `status` is `running` until the
 * run is `done`, then the terminal Subtask status.
 */
export interface SubtaskChunkOutcome {
  done: boolean;
  status: SubtaskStatus;
  progress: ProgressEvent[];
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

/**
 * One Subtask as the delegating model emits it. The model selects references
 * by **catalog index only** — it never emits reference text, and application code
 * snapshots the catalog entry's exact role+text onto the Subtask (see
 * `agent/subtasks/decomposition.ts`). `dependsOn` uses draft-local keys, resolved
 * to SQLite-assigned {@link SubtaskId}s by the data layer.
 */
export interface SubtaskProposal {
  localKey: string;
  type: string;
  prompt: string;
  /**
   * 1-based indices into the ephemeral, per-round reference catalog. Optional:
   * omitted when the subtask needs no verbatim history, and always absent from a
   * *reconstructed* historical call, whose references were resolved rounds ago.
   */
  referenceIndexes?: number[];
  /** Draft-local keys of prerequisite proposals. */
  dependsOn: string[];
}

/**
 * The model's complete `delegate` call: the acknowledgment the user sees while
 * the work runs, plus one through eight Subtask proposals. Validated against the
 * round's ephemeral catalog before anything is persisted; invalid output fails
 * the attempt (and, with both models exhausted, the round) rather than being
 * silently repaired.
 */
export interface DecompositionProposal {
  reply: string;
  subtasks: SubtaskProposal[];
}

/**
 * Terminal outcome of one main-agent round (RPC-safe).
 *
 * `replied` is the terminal answer — the round chose to answer the user rather
 * than delegate, and the Workflow delivers it. `delegated` means the round's
 * Subtask rows are durable and Phase 2 should run them, after which another round
 * begins. `failed` means both models produced unusable output; no Subtask is ever
 * synthesized to cover for it. `canceled` means the caller cancelled during the
 * round: nothing was persisted and nothing was published. Transient platform
 * faults are not results: they throw so the enclosing Workflow step can retry
 * (mirrors {@link RecipeExecutionResult}).
 */
export type TurnTaskResult =
  | { status: "replied"; reply: string }
  | { status: "delegated"; reply: string; subtasks: Subtask[] }
  | { status: "failed"; error: string }
  | { status: "canceled" };

/**
 * One branch's outcome as a later round sees it — a plain, RPC-safe subset of the
 * durable {@link Subtask} row, loaded across **every** round in stable ordinal
 * order. Completed, failed, and skipped branches are all included so the reply
 * can use available successes and disclose relevant failures.
 *
 * Carries `round`, `prompt` and `dependsOn` — not for composing, but for
 * reconstructing the per-round `delegate` call that produced these branches (see
 * `agent/subtasks/delegate.ts`). Unlike {@link SubtaskNode}, this projection is
 * built inside the DO and returns only a reply, so the 1 MiB Workflow-step cap
 * that keeps the scheduler's view narrow does not apply. `references` still stays
 * out: it is unbounded history text, and the call's shape does not need it.
 */
export interface CompositionBranch {
  subtaskId: SubtaskId;
  round: number;
  ordinal: number;
  type: string;
  prompt: string;
  dependsOn: SubtaskId[];
  status: SubtaskStatus;
  resultParts: SubtaskResultPart[] | null;
  error: string | null;
}

/**
 * The `scan:<n>` wave projection (RPC-safe): either the caller cancelled, or the
 * refreshed DAG after blocked branches were skipped. Returning the verdict with
 * the nodes is what lets the Workflow drop its separate cancellation probe — one
 * round trip, and no gap between asking and acting.
 */
export type SubtaskScan =
  { canceled: true } | { canceled: false; nodes: SubtaskNode[] };

/**
 * The scheduler's view of one Subtask (Phase 2) — everything needed to pick the
 * next dependency-ready wave, and nothing else.
 *
 * Deliberately excludes `prompt`, `references`, and `resultParts`: a Workflow
 * step return is capped at 1 MiB, and a reference is a verbatim history snapshot
 * bounded only by `MAX_INBOUND_TEXT_BYTES`, so a wave scan returning full rows
 * would overflow on a large task. The durable rows — not Workflow state — are the
 * source of truth, so the Workflow carries ids and statuses and re-reads the rest
 * through the parent when it actually needs it.
 */
export interface SubtaskNode {
  id: SubtaskId;
  ordinal: number;
  status: SubtaskStatus;
  dependsOn: SubtaskId[];
}

/** Durable state owned by the main agent for one delegated unit of work. */
export interface Subtask {
  id: SubtaskId;
  taskId: string;
  /** The main-agent round that delegated this Subtask (0-based). */
  round: number;
  /** Position within the parent Task, increasing across every round. */
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
