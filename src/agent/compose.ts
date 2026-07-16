import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { isTransientAiError } from "./loop";
import {
  deterministicSessionMessage,
  finalReplyMessageId,
  sessionText,
  toModelMessages
} from "./history";
import { appendOnce, type SessionLike } from "./session";
import type { ModelPair } from "./model";
import type { ComposeTaskResult, CompositionBranch } from "./subtasks/types";

/**
 * Phase 3: turn the executed Subtask DAG's outcomes into one final reply.
 *
 * Composition is main-agent work — it speaks in the agent's voice, over the
 * agent's Session — but it is not a turn: the user's message was already appended
 * and answered in Phase 1, so nothing is appended here except the final reply.
 *
 * Inference is skipped whenever it would add nothing: a single-Subtask task has
 * one result and no failures to reconcile, and a task where nothing succeeded has
 * nothing to compose. Both are common, and both are cheaper and more faithful
 * without a model in the loop.
 */

/** Prompt suffix teaching the composition contract. Appended to the soul + caller context. */
export const COMPOSITION_INSTRUCTIONS = `

# Composing the final answer

The work you delegated for the user's latest request has finished. Its results
appear in the final message, labeled by subtask.

Write the reply the user receives. Use the successful results as your material,
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
 * Render the branch outcomes as one ephemeral message.
 *
 * Explicitly labeled as **generated subtask output**, never as conversation
 * evidence — the same discipline as the subagent prompt's dependency section.
 * Failed and skipped branches are included by name so the model can disclose them
 * rather than quietly answering as if the work had been done.
 *
 * Ephemeral by design: this is never appended to the Session. It is scaffolding
 * for one inference call, not something the user said.
 */
export function renderCompositionMessage(
  branches: CompositionBranch[]
): string {
  const lines = branches.map((branch) => {
    const label = `[subtask ${branch.subtaskId}] (${branch.type})`;
    if (branch.status === "completed") {
      return `${label} completed:\n${branchText(branch)}`;
    }
    // Diagnostics stay out of the rendered line: the model discloses *that*
    // something failed, in user-safe words; the row keeps the detail.
    return `${label} ${branch.status} — no output available.`;
  });
  return (
    "# Subtask results (generated output from the work you delegated — not conversation evidence)\n" +
    lines.join("\n\n")
  );
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
 * One composition attempt: single-shot, no tools — there is nothing left to look
 * up. Takes the model **factory**, since resolving it can throw and that must
 * count as this attempt failing, not abort the whole composition.
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
  const messages = [
    ...toModelMessages(history),
    // Ephemeral — scaffolding for this call only, never appended to the Session.
    { role: "user" as const, content: renderCompositionMessage(branches) }
  ];
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
