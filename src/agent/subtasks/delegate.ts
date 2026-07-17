import { tool } from "ai";
import { z } from "zod";
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

/** The one description both declarations share, so the two can never drift. */
const DELEGATE_DESCRIPTION =
  "Delegate the user's request to isolated subagents and acknowledge it. Call this exactly once, when you have decided how to split the work. Its results return to you, and you then write the user's final reply from them.";

/**
 * The tool as **Phase 1** declares it. Deliberately **without `execute`**: the
 * Workflow performs this call, durably, outside the inference — so there is
 * nothing for the SDK to run, and the tool loop halts on the call rather than
 * trying to continue past it.
 *
 * Its `inputSchema` is the decomposition contract itself — the *emitted* shape,
 * with draft-local `localKey`s and catalog `referenceIndexes`, since at authoring
 * time the durable ids do not exist yet. The SDK validates the model's proposal
 * against it before it ever reaches {@link resolveDecomposition} — the same
 * guarantee `Output.object` gave, from the same schema.
 *
 * Phase 3 declares the same tool *name* under a different face —
 * {@link composeDelegateTool} — because the call it reassembles is the
 * post-resolution *durable* shape, not the emitted one.
 */
export const delegateTool = tool({
  description: DELEGATE_DESCRIPTION,
  inputSchema: decompositionProposalSchema
});

/**
 * The **resolved** `delegate` call — the durable shape, after the data layer
 * assigned SQLite ids and dropped the authoring-only `localKey`/`referenceIndexes`.
 * Distinct from {@link decompositionProposalSchema} (the emitted shape) by design:
 * the Workflow boundary between the call and its result is exactly where the
 * emitted form becomes this one.
 *
 * The single source of truth for the reconstructed call's shape — its inferred
 * types drive {@link delegateCallInput}, and {@link composeDelegateTool} declares
 * it to the provider — so the tool the compose model sees always matches the call
 * reunited into its history.
 */
export const delegatedCallSchema = z.object({
  reply: z.string(),
  subtasks: z
    .array(
      z.object({
        id: z.number().int(),
        type: z.string(),
        prompt: z.string(),
        dependsOn: z.array(z.number().int())
      })
    )
    .min(1)
    .max(8)
});

/**
 * The tool as **Phase 3** declares it: same name and description, the resolved
 * schema. Declared (never called — compose pins `toolChoice: "none"`) only so the
 * provider can interpret the reunited call-and-result against a definition whose
 * shape matches the call it sees. No `execute`, for the same reason as
 * {@link delegateTool}.
 */
export const composeDelegateTool = tool({
  description: DELEGATE_DESCRIPTION,
  inputSchema: delegatedCallSchema
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
 * The reconstructed `delegate` call's input: the acknowledgment plus the DAG, in
 * the **resolved** form. Inferred from {@link delegatedCallSchema} so the built
 * object is compile-time-checked against the schema the compose model is shown —
 * the two cannot drift.
 *
 * `id` is the same id the matching outcome carries in
 * {@link DelegateSubtaskOutcome}, so the model can line each result up with the
 * work that produced it — something the emitted call's `localKey`s (gone from the
 * durable row) could not have done.
 */
export type DelegateCallInput = z.infer<typeof delegatedCallSchema>;

/** One delegated unit of work, as the reconstructed call carries it. */
export type DelegatedSubtask = DelegateCallInput["subtasks"][number];

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
