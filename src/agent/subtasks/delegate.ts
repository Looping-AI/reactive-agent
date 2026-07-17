import { tool } from "ai";
import { decompositionProposalSchema } from "./decomposition";
import type { CompositionBranch, SubtaskId, SubtaskStatus } from "./types";

/**
 * The `delegate` tool — the single act by which the main agent hands work to
 * subagents, and the shape both ends of that act agree on.
 *
 * Delegation is a **durable tool call**: Phase 1 emits it for real (the model
 * picks it and fills its input), the Workflow performs it over minutes or hours,
 * and Phase 3 reassembles the call with its result to write the final reply. The
 * two halves are separated by a Workflow boundary, not by a fiction — nothing
 * here is fabricated on the model's behalf.
 *
 * This module owns the tool's identity because both phases depend on it agreeing:
 * Phase 3 pairs a synthesized `tool-result` to Phase 1's `tool-call` by name and
 * id, and a mismatch would not throw — it would silently produce a malformed
 * history that the model quietly misreads.
 */

export const DELEGATE_TOOL_NAME = "delegate";

/**
 * The tool as both phases declare it. Deliberately **without `execute`**: the
 * Workflow performs this call, durably, outside the inference — so there is
 * nothing for the SDK to run, and the tool loop halts on the call rather than
 * trying to continue past it.
 *
 * Its `inputSchema` is the decomposition contract itself, so the SDK validates
 * the model's proposal before it ever reaches {@link resolveDecomposition} —
 * the same guarantee `Output.object` gave, from the same schema.
 */
export const delegateTool = tool({
  description:
    "Delegate the user's request to isolated subagents and acknowledge it. Call this exactly once, when you have decided how to split the work. Its results return to you, and you then write the user's final reply from them.",
  inputSchema: decompositionProposalSchema
});

/**
 * The call's id, derived from the parent Task — deterministic and replay-safe,
 * the same discipline as the Session message ids it sits alongside (see
 * {@link file://../history.ts}). Phase 3 rebuilds it rather than storing it.
 */
export function delegateToolCallId(taskId: string): string {
  return `task:${taskId}:delegate`;
}

/**
 * One delegated unit of work, as the reconstructed call carries it.
 *
 * This is the **resolved** form, not the emitted one: the model proposed
 * `localKey` strings and `referenceIndexes`, and resolution turned those into
 * SQLite-assigned ids and snapshotted reference text. Neither the local keys nor
 * the indexes survive on the durable row, so Phase 3 rebuilds the call from what
 * actually happened rather than from what was asked for.
 *
 * That is the better record anyway: `id` here is the same id the outcome carries
 * in {@link DelegateSubtaskOutcome}, so the model can line up each result with
 * the work that produced it — something the local keys could not have done.
 */
export interface DelegatedSubtask {
  id: SubtaskId;
  type: string;
  prompt: string;
  /** Resolved prerequisite ids (the emitted call's local keys, after resolution). */
  dependsOn: SubtaskId[];
}

/** The reconstructed `delegate` call's input: the acknowledgment plus the DAG. */
export interface DelegateCallInput {
  reply: string;
  subtasks: DelegatedSubtask[];
}

/**
 * One branch's outcome, as the tool result carries it. `output` is null for any
 * branch that did not complete.
 *
 * There is no `error` field, and that is deliberate: internal diagnostics never
 * reach the model. It discloses *that* something failed, in user-safe words; the
 * durable row keeps the detail.
 *
 * A type alias, not an interface: this is serialized as the tool result's
 * `JSONValue`, and only aliases get the implicit index signature that satisfies.
 */
export type DelegateSubtaskOutcome = {
  subtaskId: SubtaskId;
  type: string;
  status: SubtaskStatus;
  output: string | null;
};

/** Rebuild the call's input from the durable rows, in stable ordinal order. */
export function delegateCallInput(
  reply: string,
  branches: CompositionBranch[]
): DelegateCallInput {
  return {
    reply,
    subtasks: branches.map((branch) => ({
      id: branch.subtaskId,
      type: branch.type,
      prompt: branch.prompt,
      dependsOn: [...branch.dependsOn]
    }))
  };
}

/** Rebuild the call's result from the durable rows, in stable ordinal order. */
export function delegateCallOutput(
  branches: CompositionBranch[]
): DelegateSubtaskOutcome[] {
  return branches.map((branch) => ({
    subtaskId: branch.subtaskId,
    type: branch.type,
    status: branch.status,
    output:
      branch.status === "completed"
        ? (branch.resultParts ?? []).map((part) => part.text).join("\n")
        : null
  }));
}
