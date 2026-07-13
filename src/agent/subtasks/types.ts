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
