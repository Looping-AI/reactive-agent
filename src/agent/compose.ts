import type { AssistantContent, LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { isTransientAiError } from "./inference";
import {
  decomposeReplyMessageId,
  deterministicSessionMessage,
  finalReplyMessageId,
  sessionText
} from "./history";
import { appendOnce, type SessionLike } from "./session";
import {
  DELEGATE_TOOL_NAME,
  delegateCallInput,
  delegateCallOutput,
  delegateTool,
  delegateToolCallId
} from "./subtasks/delegate";
import type { ModelPair } from "./model";
import type { ComposeTaskResult, CompositionBranch } from "./subtasks/types";

/**
 * Phase 3: turn the executed Subtask DAG's outcomes into one final reply.
 *
 * Composition is main-agent work — it speaks in the agent's voice, over the
 * agent's Session — but it is not a turn: the user's message was already appended
 * and answered in Phase 1, so nothing is appended here except the final reply.
 *
 * The model sees the outcomes as what they are: the **result of the `delegate`
 * call it made in Phase 1**, reunited with that call (see
 * {@link renderCompositionMessages}). That is the whole design. "Tool result →
 * assistant writes the user's reply" is a pattern every instruction-tuned model
 * has seen a million times, so it carries both facts this phase depends on —
 * that the outcomes are generated output rather than something the user said,
 * and that it is now the model's turn to answer — without a prompt having to
 * assert either in English.
 *
 * Inference is skipped whenever it would add nothing: a single-Subtask task has
 * one result and no failures to reconcile, and a task where nothing succeeded has
 * nothing to compose. Both are common, and both are cheaper and more faithful
 * without a model in the loop.
 */

/** Prompt suffix teaching the composition contract. Appended to the soul + caller context. */
export const COMPOSITION_INSTRUCTIONS = `

# Composing the final answer

Your \`${DELEGATE_TOOL_NAME}\` call has returned: its result holds the outcome of every
subtask you delegated for the user's latest request. The work is done — do not
call \`${DELEGATE_TOOL_NAME}\` again.

Write the reply the user receives. Use the completed results as your material,
in your own voice — do not paste them verbatim, introduce them as "subtask
output", or mention subtasks, subagents, or delegation. The user asked you.

If some work failed or was skipped, say plainly what you could not do, in one
short sentence, without diagnostics or blame — then give them everything you did
manage. Never present a partial answer as complete, and never invent a result for
work that failed.`;

/** User-facing note appended when a deterministic join has to disclose gaps. */
const PARTIAL_NOTE =
  "Some parts of this request could not be completed, so this answer covers " +
  "only what succeeded.";

/** Join one branch's parts into its text block. */
function branchText(branch: CompositionBranch): string {
  return (branch.resultParts ?? []).map((p) => p.text).join("\n");
}

/**
 * Rebuild the `delegate` call and pair it with its result.
 *
 * Both halves are real. Phase 1's model genuinely emitted this call; the
 * subagents genuinely produced these outcomes. All that separates them is a
 * Workflow boundary and, often, hours — so the pair is reconstructed here rather
 * than carried, from the durable rows that are the record of what happened.
 *
 * Failed and skipped branches are included so the model can disclose them rather
 * than quietly answering as if the work had been done; their diagnostics are not
 * (see {@link delegateCallOutput}).
 */
function delegationPair(
  taskId: string,
  replyText: string | null,
  branches: CompositionBranch[]
): ModelMessage[] {
  const toolCallId = delegateToolCallId(taskId);
  const content: AssistantContent = [];
  // The acknowledgment the user already saw, if it is still in history.
  if (replyText) content.push({ type: "text", text: replyText });
  content.push({
    type: "tool-call",
    toolCallId,
    toolName: DELEGATE_TOOL_NAME,
    input: delegateCallInput(replyText ?? "", branches)
  });
  return [
    { role: "assistant", content },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: DELEGATE_TOOL_NAME,
          output: { type: "json", value: delegateCallOutput(branches) }
        }
      ]
    }
  ];
}

/**
 * Render the model's view for composition: the conversation, with this task's
 * delegation restored as the call-and-result it actually was.
 *
 * The Phase 1 reply is stored as plain assistant text (history is text-only, and
 * stays that way — `sessionText`, the `[ref N]` catalog, compaction, and recall
 * all read text parts). So the tool call is re-attached to that message here,
 * and the result appended after it, for this one inference call. The same
 * ephemeral-re-rendering discipline as {@link file://./decompose.ts
 * renderDecompositionMessages}, which likewise marks up history the Session
 * never sees.
 *
 * The pair is emitted together, anchored on the Phase 1 reply's deterministic id,
 * so a `tool` message can never be orphaned from its call. Should that reply be
 * gone — compacted away by a concurrent task — the pair still lands, minus the
 * acknowledgment text: a result the model cannot place beats a malformed history.
 */
export function renderCompositionMessages(
  history: SessionMessage[],
  taskId: string,
  branches: CompositionBranch[]
): ModelMessage[] {
  const replyId = decomposeReplyMessageId(taskId);
  const messages: ModelMessage[] = [];
  let anchored = false;
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = sessionText(message);
    if (message.id !== replyId) {
      messages.push({ role: message.role, content: text });
      continue;
    }
    messages.push(...delegationPair(taskId, text, branches));
    anchored = true;
  }
  if (!anchored) messages.push(...delegationPair(taskId, null, branches));
  return messages;
}

/**
 * Deterministic fallback reply: the successful branches' text in ordinal order,
 * plus a short note when some branches did not succeed.
 *
 * Used when composition inference is unavailable. The branch work is already done
 * and durable — failing the whole Task because the summarizing model is down would
 * throw away good results the user asked for.
 */
export function joinSuccessfulBranches(branches: CompositionBranch[]): string {
  const successes = branches.filter((b) => b.status === "completed");
  const body = successes.map(branchText).join("\n\n");
  const incomplete = branches.length > successes.length;
  return incomplete ? `${body}\n\n${PARTIAL_NOTE}` : body;
}

export interface RunComposeArgs {
  /** The DO's one continuous Session. */
  session: SessionLike;
  /** Parent Task id — derives the deterministic final-reply message id. */
  taskId: string;
  /** Per-request system-prompt suffix (verified caller context). */
  systemSuffix: string;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Every branch of the executed DAG, in stable ordinal order. */
  branches: CompositionBranch[];
}

/**
 * One composition attempt: single-shot — there is nothing left to look up.
 * Takes the model **factory**, since resolving it can throw and that must count
 * as this attempt failing, not abort the whole composition.
 *
 * `delegate` is declared but forbidden: the history contains a call to it, which
 * a provider can only make sense of against the tool's definition, while
 * `toolChoice: "none"` keeps the model from delegating the same work twice.
 * Should it call anyway, `result.text` comes back empty and the check below
 * fails the attempt — the fallback model, and then the deterministic join, are
 * already the net for that.
 */
async function attempt(
  model: () => LanguageModel,
  system: string,
  messages: ModelMessage[]
): Promise<string> {
  const result = await generateText({
    model: model(),
    system,
    messages,
    tools: { [DELEGATE_TOOL_NAME]: delegateTool },
    toolChoice: "none",
    maxRetries: 0
  });
  const text = result.text.trim();
  if (!text || result.finishReason === "length") {
    throw new Error(
      `unusable composition response (finishReason=${result.finishReason}, empty=${!text})`
    );
  }
  return text;
}

/**
 * Compose the terminal reply from the DAG's outcomes and persist it to the
 * Session.
 *
 * Throws only on a transient platform fault (for the Workflow step to retry).
 * A deterministic double-model failure degrades to {@link joinSuccessfulBranches}
 * rather than discarding completed work.
 */
export async function runCompose(
  args: RunComposeArgs
): Promise<ComposeTaskResult> {
  const { session, taskId, systemSuffix, models, branches } = args;
  const replyId = finalReplyMessageId(taskId);

  // Recovery: this step already ran and its reply is durable. Return it without
  // inference — re-composing could produce different words for a reply the user
  // may already have received.
  const existing = await session.getMessage(replyId);
  if (existing) return { status: "completed", reply: sessionText(existing) };

  const successes = branches.filter((b) => b.status === "completed");

  if (successes.length === 0) {
    // Nothing to compose from. The parent Task fails; composition inference would
    // only produce an apology dressed as an answer.
    const detail = branches
      .map((b) => `subtask ${b.subtaskId} (${b.type}): ${b.status}`)
      .join("; ");
    return {
      status: "failed",
      error: `no subtask succeeded — ${detail}`
    };
  }

  // Single-node bypass: one subtask, and it succeeded. Its result *is* the
  // answer — there are no siblings to reconcile and no failures to disclose, so
  // composition inference would only paraphrase a finished reply.
  if (branches.length === 1) {
    const reply = await appendOnce(
      session,
      deterministicSessionMessage(replyId, "assistant", branchText(branches[0]))
    );
    return { status: "completed", reply };
  }

  const history = await session.getHistory();
  // Ephemeral — scaffolding for this call only, never appended to the Session.
  const messages = renderCompositionMessages(history, taskId, branches);
  const system =
    (await session.refreshSystemPrompt()) +
    systemSuffix +
    COMPOSITION_INSTRUCTIONS;

  const errors: unknown[] = [];
  for (const slot of ["primary", "fallback"] as const) {
    const modelId =
      slot === "primary" ? models.primaryId() : models.fallbackId();
    let text: string;
    try {
      // Scoped to the inference itself. A Session write is not a model failure:
      // retrying the fallback model would not fix it, and the diagnostic would
      // blame the wrong thing — so the append below stays outside this catch.
      text = await attempt(
        slot === "primary" ? models.primary : models.fallback,
        system,
        messages
      );
    } catch (error) {
      errors.push(error);
      console.warn("[compose] model attempt failed", {
        model: modelId,
        error: String(error)
      });
      continue;
    }
    const reply = await appendOnce(
      session,
      deterministicSessionMessage(replyId, "assistant", text)
    );
    return { status: "completed", reply };
  }

  const transient = errors.find((e) => isTransientAiError(e));
  if (transient) throw transient;

  // Both models failed deterministically. The branch results are durable and
  // useful; deliver them joined rather than failing a Task whose work is done.
  console.warn("[compose] falling back to deterministic join", { taskId });
  const reply = await appendOnce(
    session,
    deterministicSessionMessage(
      replyId,
      "assistant",
      joinSuccessfulBranches(branches)
    )
  );
  return { status: "completed", reply };
}
