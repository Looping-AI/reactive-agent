import { tool } from "ai";
import { decompositionProposalSchema } from "./decomposition";
import type {
  CompositionBranch,
  DecompositionProposal,
  SubtaskId,
  SubtaskStatus
} from "./types";

/**
 * The `delegate` tool — the single act by which the main agent hands work to
 * subagents, and the shape both ends of that act agree on.
 *
 * Delegation is a **durable tool call**: a round emits it for real (the model
 * picks it and fills its input), the Workflow performs it over minutes or hours,
 * and a later round reassembles the call with its result to keep working. The two
 * halves are separated by a Workflow boundary, not by a fiction — nothing here is
 * fabricated on the model's behalf.
 *
 * This module owns the tool's identity because every round depends on it
 * agreeing: a later round pairs a synthesized `tool-result` to an earlier round's
 * `tool-call` by name and id, and a mismatch would not throw — it would silently
 * produce a malformed history that the model quietly misreads.
 */

export const DELEGATE_TOOL_NAME = "delegate";

/**
 * The tool as the model sees it. Deliberately **without `execute`**: the Workflow
 * performs this call, durably, outside the inference — so there is nothing for the
 * SDK to run, and the tool loop halts on the call rather than trying to continue
 * past it. That is what makes it a *control* tool: unlike the agent's work tools
 * (`recall`, `browser_*`, `set_context`), calling it ends the round.
 *
 * Its `inputSchema` is the delegation contract itself, and it is the **only**
 * declaration of this tool. One schema has to serve both directions — the calls
 * the model emits now, and the calls reconstructed from durable rows in later
 * rounds — because a provider cannot be shown two shapes for one tool name in a
 * single request. See {@link delegateCallInput} for how a durable row is rendered
 * back into it.
 */
export const delegateTool = tool({
  description:
    "Delegate part of the user's request to isolated subagents and acknowledge it. Their results return to you, and you then decide what to do next — answer the user, or delegate again.",
  inputSchema: decompositionProposalSchema
});

/**
 * The call's id, derived from the parent Task and the round that emitted it —
 * deterministic and replay-safe, the same discipline as the Session message ids
 * it sits alongside (see {@link file://../history.ts}). Later rounds rebuild it
 * rather than storing it.
 */
export function delegateToolCallId(taskId: string, round: number): string {
  return `task:${taskId}:round:${round}:delegate`;
}

/**
 * The draft-local key a reconstructed call uses for a durable Subtask.
 *
 * A row does not keep the `localKey` its round's model chose — the data layer
 * resolved it to a SQLite id and dropped it. So reconstruction derives a stable
 * key from that id instead: the *same* id the matching outcome carries in
 * {@link DelegateSubtaskOutcome}, so the model can line each result up with the
 * work that produced it.
 */
function localKeyForId(id: SubtaskId): string {
  return `s${id}`;
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

/**
 * Rebuild one round's call input from its durable rows, in stable ordinal order.
 * Typed as {@link DecompositionProposal} — the same type the model's own calls
 * are validated into — so the reconstructed call and an emitted one cannot drift
 * apart in shape.
 *
 * `referenceIndexes` is omitted rather than faked: this round's references were
 * snapshotted verbatim onto the rows when it ran, and the catalog they were
 * chosen from is long gone.
 */
export function delegateCallInput(
  reply: string,
  branches: CompositionBranch[]
): DecompositionProposal {
  return {
    reply,
    subtasks: branches.map((branch) => ({
      localKey: localKeyForId(branch.subtaskId),
      type: branch.type,
      prompt: branch.prompt,
      dependsOn: branch.dependsOn.map(localKeyForId)
    }))
  };
}

/** Rebuild one round's call result from its durable rows, in stable ordinal order. */
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
