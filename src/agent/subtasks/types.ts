import type { ConversationPart } from "@/a2a/parts";

export type SubtaskStatus =
  "pending" | "running" | "completed" | "failed" | "skipped" | "canceled";

/** A per-caller, SQLite-assigned, monotonically increasing Subtask identifier. */
export type SubtaskId = number;

/** A per-caller, monotonically assigned identifier for a source Session part. */
export type SessionPartId = number;

/** A reference resolved from live Session storage immediately before execution. */
export interface ResolvedReferencePart {
  partId: SessionPartId;
  role: "user" | "assistant";
  author?: string;
  channel?: string;
  part: ConversationPart;
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
  referencePartIds: SessionPartId[];
  dependsOn: SubtaskId[];
  status: SubtaskStatus;
  resultParts: ConversationPart[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
