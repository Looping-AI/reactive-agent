import type {
  AssistantContent,
  LanguageModel,
  ModelMessage,
  ToolSet
} from "ai";
import { generateText, hasToolCall, stepCountIs } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { MAX_STEPS, MAX_SUBTASKS } from "@/config";
import {
  buildIntermediateContentHandler,
  isTransientAiError,
  type OnContent
} from "./inference";
import {
  deterministicSessionMessage,
  finalReplyMessageId,
  parseRoundAckMessageId,
  roundAckMessageId,
  sessionText,
  taskUserMessageId
} from "./history";
import { appendOnce, type SessionLike } from "./session";
import {
  isCatalogEligible,
  type ReferenceCatalogEntry
} from "./subtasks/catalog";
import { resolveDecomposition } from "./subtasks/decomposition";
import {
  DELEGATE_TOOL_NAME,
  delegateCallInput,
  delegateCallOutput,
  delegateTool,
  delegateToolCallId
} from "./subtasks/delegate";
import type { ModelPair } from "./model";
import type {
  CompositionBranch,
  DecompositionProposal,
  SubtaskDraft
} from "./subtasks/types";

/**
 * One **round** of the main agent: a single inference over the agent's continuous
 * Session that ends in one of two decisions — answer the user, or delegate.
 *
 * This is the whole task pipeline's control point. The Workflow runs rounds in a
 * loop: a round that delegates gets its Subtask DAG executed and is followed by
 * another round; a round that answers ends the Task. So "compose" is not a
 * separate phase with its own rules — it is simply the round in which the model
 * decides it has enough to answer.
 *
 * Two layers of tools, and the difference is the design:
 *
 * - **Work tools** (`recall`, `browser_*`, the Session's `set_context`) carry an
 *   `execute` and run *inside* the round's tool loop. They never end a round; the
 *   model keeps reasoning over their results. Every round gets them, including the
 *   one that writes the final reply — looking something up before answering is
 *   ordinary work, not a special phase.
 * - **Control tools** — today only {@link delegateTool} — have no `execute`. The
 *   call *is* the round's output: the loop halts on it and the Workflow performs
 *   it durably. A future `escalate` (ask the human) is the same shape: another
 *   variant of {@link TurnDecision}, another `case` in the Workflow's switch.
 *
 * Nothing forces the choice. An earlier design pinned `toolChoice` to force
 * delegation in one phase and forbid it in another, which meant a request the main
 * agent was best placed to answer got shipped to a memoryless subagent, and
 * material that came back could only ever be turned into prose. Here plain text is
 * a first-class outcome, and delegating twice is allowed — the model decides, and
 * only the round budget bounds it.
 *
 * The model reasons over the whole conversation but references it by **catalog
 * index only** — see {@link renderTurnMessages}.
 */

/** Prompt suffix teaching the round contract. Appended to the soul + caller context. */
export const TURN_INSTRUCTIONS = `

# Answering this request

You are replying to the user yourself. You have two ways to act, and the choice is
yours:

**1. Answer directly.** Write your reply as plain text. Do this whenever the
request is yours to answer — anything about this conversation, your own history,
memory, or tools, and anything you can settle with the tools available to you
here. Use those tools first if they help: look something up, recall older history,
then answer.

**2. Delegate.** Call the \`${DELEGATE_TOOL_NAME}\` tool to hand work to isolated
subagents that run concurrently — research, long-running jobs, or anything better
done in parallel by a capable stranger. Their results come back to you, and you
then decide again: answer, or delegate once more.

Do not delegate work you can simply do. Do not answer from thin air work that
genuinely needs doing.

## Delegating

\`${DELEGATE_TOOL_NAME}\` takes:

- "reply": the acknowledgment the user sees while the work runs, in your own voice.
  Say what you are doing about their request. Do not promise a delivery time, and
  do not mention subtasks, subagents, or this process.
- "subtasks": between 1 and ${MAX_SUBTASKS} units of work. Use exactly as many as the
  request genuinely needs — one is the right answer for a simple request. Prefer
  fewer, larger subtasks over many trivial ones.

Each subtask has:

- "localKey": a short unique identifier within this call (e.g. "research").
- "type": a short semantic label for the kind of work (e.g. "research", "draft").
- "prompt": a complete, self-contained instruction. The subagent executing it has
  no memory, no conversation history, and no access to this session — everything
  it needs must be in this prompt or in the references you select. Write it as an
  instruction to a capable stranger.
- "referenceIndexes": the indexes of conversation turns the subagent must read
  verbatim, chosen from the turns marked "[ref N]" below. Reference only what that
  subtask actually needs. Turns without a "[ref N]" marker cannot be referenced;
  if information from one matters, restate it in the prompt yourself.
- "dependsOn": the localKeys this subtask needs the output of. Leave it empty for
  work that can start immediately. Dependent subtasks receive their prerequisites'
  output. The graph must be acyclic, and may only reference subtasks in this same
  call.

Subtasks with no dependency between them run at the same time, so only add an edge
where output genuinely feeds input.

Ask each subtask for the **material** you need, not for a finished answer: its
output is raw material for you, never something the user sees directly.

## Using results that have come back

When a \`${DELEGATE_TOOL_NAME}\` call's results are already in this conversation, they are
yours to use. Write in your own voice — do not paste results verbatim, introduce
them as "subtask output", or mention subtasks, subagents, or delegation. The user
asked you.

If some work failed or was skipped, say plainly what you could not do, in one
short sentence, without diagnostics or blame — then give them everything you did
manage. Never present a partial answer as complete, and never invent a result for
work that failed. If more work is genuinely needed, delegate again instead of
guessing.

## Playing an ARC-AGI-3 game

If the user asks you to play an ARC-AGI-3 game (e.g. "play game ls20"), delegate
**exactly one** subtask with "type": "arc-game", no dependencies and no other
subtasks. Put the game the user named verbatim in its "prompt" (e.g. "Play the
ARC-AGI-3 game ls20."). This runs long — acknowledge in your "reply" that you have
started playing and will report back, without promising a time.`;

/**
 * Appended instead of the delegation half when the round may not delegate — the
 * last round of the budget, or a Task that has spent its execution budget. The
 * tool is not declared at all in that case, so this only explains a constraint the
 * model can already see.
 */
export const FINAL_ROUND_INSTRUCTIONS = `

# No further delegation

You cannot delegate on this turn — answer the user now, from what you already
have. If something is missing or failed, say so plainly and give them the rest.`;

/** User-facing note appended when a deterministic join has to disclose gaps. */
const PARTIAL_NOTE =
  "Some parts of this request could not be completed, so this answer covers " +
  "only what succeeded.";

/** Join one branch's parts into its text block. */
function branchText(branch: CompositionBranch): string {
  return (branch.resultParts ?? []).map((p) => p.text).join("\n");
}

/** Group every branch by the round that delegated it, preserving ordinal order. */
function byRound(
  branches: CompositionBranch[]
): Map<number, CompositionBranch[]> {
  const rounds = new Map<number, CompositionBranch[]>();
  for (const branch of branches) {
    const existing = rounds.get(branch.round);
    if (existing) existing.push(branch);
    else rounds.set(branch.round, [branch]);
  }
  return rounds;
}

/**
 * Rebuild one round's `delegate` call and pair it with its result.
 *
 * Both halves are real. That round's model genuinely emitted this call; the
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
  round: number,
  replyText: string | null,
  branches: CompositionBranch[]
): ModelMessage[] {
  const toolCallId = delegateToolCallId(taskId, round);
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
 * Render the model's view for one round: the conversation, with every earlier
 * round's delegation restored as the call-and-result it actually was, and every
 * referenceable turn marked with the catalog index the model selects it by.
 *
 * One pass, two jobs, because they have to agree. The `[ref N]` markers use
 * {@link isCatalogEligible} — the same predicate the catalog is numbered with — so
 * a marker and its entry can never drift: compaction summaries (`assistant` role,
 * generated) stay in the messages unmarked, readable for context but structurally
 * uncitable as conversation evidence, which is exactly the intent.
 *
 * A round's acknowledgment is stored as plain assistant text (history is
 * text-only, and stays that way — `sessionText`, the catalog, compaction, and
 * recall all read text parts). So its `delegate` call is re-attached to that
 * message here, and the result appended after it, for this one inference call. The
 * pair is emitted together, anchored on the ack's deterministic id, so a `tool`
 * message can never be orphaned from its call — and an ack that has been compacted
 * away still gets its pair, appended at the end minus the acknowledgment text: a
 * result the model cannot place beats a malformed history.
 *
 * Acks are deliberately **not** catalog-eligible: they are the agent's own
 * scaffolding, and a subtask referencing "I'm on it" as verbatim conversation
 * evidence would be noise. That holds for every ack in the Session, not only the
 * ones this render can pair with branches — see {@link parseRoundAckMessageId}.
 *
 * Everything here is ephemeral — scaffolding for this call only. Reference text is
 * snapshotted from the catalog (see
 * {@link file://./subtasks/decomposition.ts}), so no `[ref N]` prefix ever reaches
 * a Subtask, and the Session never sees any of this markup.
 */
export function renderTurnMessages(
  history: SessionMessage[],
  taskId: string,
  branches: CompositionBranch[]
): { messages: ModelMessage[]; catalog: ReferenceCatalogEntry[] } {
  const rounds = byRound(branches);
  const ackIds = new Map(
    [...rounds.keys()].map((round) => [roundAckMessageId(taskId, round), round])
  );

  const catalog: ReferenceCatalogEntry[] = [];
  const messages: ModelMessage[] = [];
  const anchored = new Set<number>();

  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role;
    const text = sessionText(message);

    const round = ackIds.get(message.id);
    if (round !== undefined) {
      messages.push(
        ...delegationPair(taskId, round, text, rounds.get(round) ?? [])
      );
      anchored.add(round);
      continue;
    }

    // An acknowledgment with no branches behind it — recognized by id, since
    // nothing in the message body distinguishes an ack from ordinary assistant
    // prose. This Task's own is the crash-window leftover: the ack landed, the
    // rows did not, and this render belongs to the retry that will decide the
    // round again. Dropping it is what makes that retry a clean re-decision —
    // left in, it reads as "already delegated" and invites the model to answer
    // instead of delegating, ending the Task with no work done. Another Task's
    // ack is real history the user saw, so it stays as context, but uncitable:
    // no round of *this* Task can hold it up as conversation evidence.
    const ack = parseRoundAckMessageId(message.id);
    if (ack) {
      if (ack.taskId !== taskId) messages.push({ role, content: text });
      continue;
    }

    if (!isCatalogEligible(message)) {
      // Not referenceable (a compaction summary): still context for reasoning.
      messages.push({ role, content: text });
      continue;
    }
    const index = catalog.length + 1;
    catalog.push({ index, role, text });
    messages.push({ role, content: `[ref ${index}] ${text}` });
  }

  // Rounds whose acknowledgment is no longer in history (compacted away by a
  // concurrent task), in round order so the results still read chronologically.
  const orphaned = [...rounds.entries()]
    .filter(([round]) => !anchored.has(round))
    .sort(([a], [b]) => a - b);
  for (const [round, roundBranches] of orphaned) {
    messages.push(...delegationPair(taskId, round, null, roundBranches));
  }

  return { messages, catalog };
}

/**
 * Deterministic fallback reply: the successful branches' text in ordinal order,
 * plus a short note when some branches did not succeed.
 *
 * Used when a round's inference is unavailable but its predecessors' work is
 * durable. Failing the whole Task because the answering model is down would throw
 * away good results the user asked for.
 */
export function joinSuccessfulBranches(branches: CompositionBranch[]): string {
  const successes = branches.filter((b) => b.status === "completed");
  const body = successes.map(branchText).join("\n\n");
  const incomplete = branches.length > successes.length;
  return incomplete ? `${body}\n\n${PARTIAL_NOTE}` : body;
}

/** What one round decided. A future `escalate` is another variant here. */
export type TurnDecision =
  | { kind: "reply"; text: string }
  | { kind: "delegate"; proposal: DecompositionProposal };

export interface RunTurnArgs {
  /** The DO's one continuous Session. */
  session: SessionLike;
  /** Parent Task id — derives the deterministic Session message ids. */
  taskId: string;
  /** 0-based round within this Task. */
  round: number;
  /** The inbound user text (keeps its `<turn>` provenance wrapper verbatim). Appended on round 0 only. */
  text: string;
  /** Whether this round may delegate; false ⇒ the control tools are not declared at all. */
  allowControl: boolean;
  /** Per-request system-prompt suffix (verified caller context). */
  systemSuffix: string;
  /** The main agent's gated **work** tools, merged over the session's own tools. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Every earlier round's branches, all rounds, in stable ordinal order. */
  branches: CompositionBranch[];
  /** Streams intermediate content while the model reasons. Best-effort. */
  onContent?: OnContent;
}

/**
 * Terminal outcome of one round. `failed` means both models produced unusable
 * output *and* there was no durable work to fall back on — the parent Task fails
 * rather than running a synthesized subtask nobody asked for. Transient faults
 * throw instead (the Workflow step retries).
 */
export type RunTurnOutcome =
  | { status: "replied"; reply: string }
  | { status: "delegated"; reply: string; drafts: SubtaskDraft[] }
  | { status: "failed"; error: string };

type Attempt =
  { ok: true; decision: TurnDecision } | { ok: false; error: unknown };

/**
 * One attempt against a single model: let it work, and take whichever ending it
 * lands on.
 *
 * Takes the model **factory**, not a model: resolving it can throw (a missing
 * binding, a bad id), and that has to count as this attempt failing so the other
 * model still gets its turn.
 *
 * The model uses its work tools freely — answering well can genuinely need a
 * lookup or a recall — and the loop ends one of two ways: it calls `delegate` (no
 * `execute`, so there is nothing to continue from and the loop halts on the call),
 * or it stops with text, which *is* the reply. Text alongside a `delegate` call is
 * a preamble, not an answer: the control call wins.
 *
 * Every deterministic failure collapses to `{ ok: false }`: the SDK rejects a call
 * whose input violates the schema (`InvalidToolInputError`) or names an unknown
 * tool (`NoSuchToolError`), and a run that ended with neither a decision nor text
 * — burning `MAX_STEPS` mid-tool-use — is caught below.
 */
async function attempt(
  args: RunTurnArgs,
  model: () => LanguageModel,
  system: string,
  messages: ModelMessage[]
): Promise<Attempt> {
  try {
    const result = await generateText({
      model: model(),
      system,
      messages,
      tools: args.allowControl
        ? { ...args.tools, [DELEGATE_TOOL_NAME]: delegateTool }
        : args.tools,
      stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(DELEGATE_TOOL_NAME)],
      // We do our own primary → fallback recovery, so disable the SDK's
      // per-model backoff (it would only add latency and duplicate the fallback).
      maxRetries: 0,
      onStepFinish: args.onContent
        ? buildIntermediateContentHandler(args.onContent, [DELEGATE_TOOL_NAME])
        : undefined
    });

    const delegates = result.toolCalls.filter(
      (c) => c.toolName === DELEGATE_TOOL_NAME
    );
    if (delegates.length > 1) {
      return {
        ok: false,
        error: new Error(
          `model called ${DELEGATE_TOOL_NAME} ${delegates.length} times in one turn`
        )
      };
    }
    if (delegates.length === 1) {
      // Already schema-validated by the SDK against the tool's `inputSchema`.
      return {
        ok: true,
        decision: {
          kind: "delegate",
          proposal: delegates[0].input as DecompositionProposal
        }
      };
    }

    const text = result.text.trim();
    if (!text || result.finishReason === "length") {
      return {
        ok: false,
        error: new Error(
          `round produced no decision (finishReason=${result.finishReason}, empty=${!text})`
        )
      };
    }
    return { ok: true, decision: { kind: "reply", text } };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Run one round against the continuous Session: append the user turn (round 0),
 * let the model decide over the indexed history, validate any delegation against
 * this round's catalog, and persist what the user will see.
 *
 * Every append uses a deterministic id, so a Workflow-step re-run neither
 * duplicates the turn nor changes an already-delivered reply.
 *
 * Throws only on a transient platform fault (for the Workflow step to retry).
 * A deterministic double-model failure with durable work behind it degrades to
 * {@link joinSuccessfulBranches} rather than discarding completed branches; with
 * nothing behind it, it resolves to `{ status: "failed" }`.
 */
export async function runTurn(args: RunTurnArgs): Promise<RunTurnOutcome> {
  const { session, taskId, round, text, systemSuffix, models, branches } = args;

  if (round === 0) {
    await appendOnce(
      session,
      deterministicSessionMessage(taskUserMessageId(taskId), "user", text)
    );
  }

  const history = await session.getHistory();
  const { messages, catalog } = renderTurnMessages(history, taskId, branches);
  const system =
    (await session.refreshSystemPrompt()) +
    systemSuffix +
    TURN_INSTRUCTIONS +
    (args.allowControl ? "" : FINAL_ROUND_INSTRUCTIONS);

  const diagnostics: string[] = [];
  const errors: unknown[] = [];

  for (const slot of ["primary", "fallback"] as const) {
    const modelId =
      slot === "primary" ? models.primaryId() : models.fallbackId();
    const model = slot === "primary" ? models.primary : models.fallback;

    const outcome = await attempt(args, model, system, messages);
    if (!outcome.ok) {
      errors.push(outcome.error);
      diagnostics.push(`${slot} (${modelId}): ${String(outcome.error)}`);
      console.warn("[turn] model attempt failed", {
        taskId,
        round,
        model: modelId,
        error: String(outcome.error)
      });
      continue;
    }

    if (outcome.decision.kind === "reply") {
      // A throw here is a storage fault: it propagates so the step retries.
      const reply = await appendOnce(
        session,
        deterministicSessionMessage(
          finalReplyMessageId(taskId),
          "assistant",
          outcome.decision.text
        )
      );
      return { status: "replied", reply };
    }

    let resolved: ReturnType<typeof resolveDecomposition>;
    try {
      // Validation failure counts as an attempt failure: the other model gets a
      // chance to produce a usable graph before the round fails. Scoped tightly to
      // the validation itself — a Session write is not a model problem, and must
      // not be retried against the fallback or reported as bad model output.
      resolved = resolveDecomposition(outcome.decision.proposal, catalog);
    } catch (error) {
      errors.push(error);
      diagnostics.push(`${slot} (${modelId}): ${String(error)}`);
      console.warn("[turn] invalid delegation", {
        taskId,
        round,
        model: modelId,
        error: String(error)
      });
      continue;
    }

    const stored = await appendOnce(
      session,
      deterministicSessionMessage(
        roundAckMessageId(taskId, round),
        "assistant",
        resolved.reply
      )
    );
    return { status: "delegated", reply: stored, drafts: resolved.drafts };
  }

  // A transient fault is not a decision failure — let the step retry rather than
  // failing the user's Task over Workers-AI capacity.
  const transient = errors.find((e) => isTransientAiError(e));
  if (transient) throw transient;

  const detail = `round ${round} exhausted both models — ${diagnostics.join("; ")}`;

  // Both models failed deterministically. Any branch results behind us are durable
  // and useful; deliver them joined rather than failing a Task whose work is done.
  if (branches.some((b) => b.status === "completed")) {
    console.warn("[turn] falling back to deterministic join", {
      taskId,
      round
    });
    const reply = await appendOnce(
      session,
      deterministicSessionMessage(
        finalReplyMessageId(taskId),
        "assistant",
        joinSuccessfulBranches(branches)
      )
    );
    return { status: "replied", reply };
  }

  return { status: "failed", error: detail };
}
