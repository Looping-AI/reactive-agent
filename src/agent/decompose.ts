import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { generateText, hasToolCall, stepCountIs } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { MAX_STEPS, MAX_SUBTASKS } from "@/config";
import {
  buildIntermediateContentHandler,
  isTransientAiError,
  type OnContent
} from "./inference";
import {
  decomposeReplyMessageId,
  deterministicSessionMessage,
  sessionText,
  taskUserMessageId
} from "./history";
import { appendOnce, type SessionLike } from "./session";
import {
  isCatalogEligible,
  type ReferenceCatalogEntry
} from "./subtasks/catalog";
import { resolveDecomposition } from "./subtasks/decomposition";
import { DELEGATE_TOOL_NAME, delegateTool } from "./subtasks/delegate";
import type { ModelPair } from "./model";
import type { DecompositionProposal, SubtaskDraft } from "./subtasks/types";

/**
 * Phase 1: turn one inbound task into a validated 1..8-node Subtask DAG plus the
 * first user-visible reply.
 *
 * The model delegates by **calling {@link delegateTool}** — a real tool call it
 * picks and fills, which the Workflow then performs durably and
 * {@link file://./compose.ts compose.ts} reassembles with its result. The tool has
 * no `execute`, so the call *is* the output: the loop halts on it and its
 * schema-validated input is the proposal.
 *
 * Deliberately **not** layered on a shared turn loop with compose.ts: this has a
 * different output contract (a validated DAG, not prose), a different failure
 * contract (a typed failure fails the parent Task — it never resolves to a
 * friendly string), and different Session semantics (deterministic, replay-safe
 * message ids). It reuses what genuinely is shared: the model pair and manual
 * fallback shape, the tool set, the history conversion, and the intermediate
 * content handler from {@link file://./inference.ts inference.ts}.
 *
 * The model reasons over the whole conversation but references it by **catalog
 * index only** — see {@link renderDecompositionMessages}.
 */

/** Prompt suffix teaching the decomposition contract. Appended to the soul + caller context. */
export const DECOMPOSITION_INSTRUCTIONS = `

# Task decomposition

Decompose the latest user request into durable subtasks that isolated subagents
will execute concurrently, and hand them off by calling the \`${DELEGATE_TOOL_NAME}\` tool.
Call it exactly once, once you have decided how to split the work — it is the only
way to act on the request.

Its results come back to you, and you then write the user's final reply from them.
So ask each subtask for the **material** you need, not for a finished answer: its
output is raw material you will compose, never something the user sees directly.

\`${DELEGATE_TOOL_NAME}\` takes:

- "reply": the first thing the user sees, in your own voice. Acknowledge what you
  are doing about their request. Do not promise a delivery time, and do not
  mention subtasks, subagents, or this decomposition process.
- "subtasks": between 1 and ${MAX_SUBTASKS} units of work. Use exactly as many as the
  request genuinely needs — one is the right answer for a simple request. Prefer
  fewer, larger subtasks over many trivial ones.

Each subtask has:

- "localKey": a short unique identifier within this decomposition (e.g. "research").
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
  output. The graph must be acyclic.

Subtasks with no dependency between them run at the same time, so only add an edge
where output genuinely feeds input.

## Playing an ARC-AGI-3 game

If the user asks you to play an ARC-AGI-3 game (e.g. "play game ls20"), emit
**exactly one** subtask with "type": "arc-game", no dependencies and no other
subtasks. Put the game the user named verbatim in its "prompt" (e.g. "Play the
ARC-AGI-3 game ls20."). This runs long — acknowledge in your "reply" that you have
started playing and will report back, without promising a time.`;

/**
 * Render the model's view of the conversation, marking each referenceable turn
 * with the catalog index the model selects it by.
 *
 * Built in **one pass** with {@link isCatalogEligible}, the same predicate
 * `buildReferenceCatalog` uses, so a marker and its catalog entry can never
 * drift: compaction summaries (`assistant` role, generated) stay in the messages
 * unmarked — the model reads them for context but cannot cite them as
 * conversation evidence, which is exactly the intent.
 *
 * The `[ref N]` prefixes exist **only** in this transient model input. Reference
 * text is snapshotted from the catalog (see
 * {@link file://./subtasks/decomposition.ts}), so no prefix ever reaches a Subtask.
 */
export function renderDecompositionMessages(history: SessionMessage[]): {
  messages: ModelMessage[];
  catalog: ReferenceCatalogEntry[];
} {
  const catalog: ReferenceCatalogEntry[] = [];
  const messages: ModelMessage[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role;
    const text = sessionText(message);
    if (!isCatalogEligible(message)) {
      // Not referenceable (a compaction summary): still context for reasoning.
      messages.push({ role, content: text });
      continue;
    }
    const index = catalog.length + 1;
    catalog.push({ index, role, text });
    messages.push({ role, content: `[ref ${index}] ${text}` });
  }
  return { messages, catalog };
}

export interface RunDecomposeArgs {
  /** The DO's one continuous Session. */
  session: SessionLike;
  /** Parent Task id — derives the deterministic Session message ids. */
  taskId: string;
  /** The inbound user text (keeps its `<turn>` provenance wrapper verbatim). */
  text: string;
  /** Per-request system-prompt suffix (verified caller context). */
  systemSuffix: string;
  /** The main agent's gated tools, merged over the session's own tools. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Streams intermediate content while the model reasons. Best-effort. */
  onContent?: OnContent;
}

/**
 * Terminal outcome of the operation. `failed` means both models produced unusable
 * output — the parent Task fails rather than running a synthesized subtask nobody
 * asked for. Transient faults throw instead (the Workflow step retries).
 */
export type DecomposeOutcome =
  | { status: "completed"; reply: string; drafts: SubtaskDraft[] }
  | { status: "failed"; error: string };

type Attempt =
  { ok: true; proposal: DecompositionProposal } | { ok: false; error: unknown };

/**
 * One attempt against a single model: let it work, and require it to land on a
 * `delegate` call.
 *
 * Takes the model **factory**, not a model: resolving it can throw (a missing
 * binding, a bad id), and that has to count as this attempt failing so the other
 * model still gets its turn.
 *
 * The model may use its own tools freely first — decomposing well can genuinely
 * need a lookup or a recall — but it cannot wander: the loop halts the moment
 * `delegate` is called (the tool has no `execute`, so there is no result to
 * continue from), and the last permitted step forces the pick so a research loop
 * can never burn `MAX_STEPS` without producing a decomposition.
 *
 * Every deterministic failure collapses to `{ ok: false }`: the SDK rejects a
 * call whose input violates the schema (`InvalidToolInputError`) or names an
 * unknown tool (`NoSuchToolError`), and a run that stopped without delegating at
 * all is caught below.
 */
async function attempt(
  args: RunDecomposeArgs,
  model: () => LanguageModel,
  system: string,
  messages: ModelMessage[]
): Promise<Attempt> {
  try {
    const result = await generateText({
      model: model(),
      system,
      messages,
      tools: { ...args.tools, [DELEGATE_TOOL_NAME]: delegateTool },
      stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(DELEGATE_TOOL_NAME)],
      prepareStep: ({ stepNumber }) =>
        stepNumber === MAX_STEPS - 1
          ? { toolChoice: { type: "tool", toolName: DELEGATE_TOOL_NAME } }
          : {},
      // We do our own primary → fallback recovery, so disable the SDK's
      // per-model backoff (it would only add latency and duplicate the fallback).
      maxRetries: 0,
      onStepFinish: args.onContent
        ? buildIntermediateContentHandler(args.onContent)
        : undefined
    });
    const delegates = result.toolCalls.filter(
      (c) => c.toolName === DELEGATE_TOOL_NAME
    );
    if (delegates.length !== 1) {
      return {
        ok: false,
        error: new Error(
          `model must call ${DELEGATE_TOOL_NAME} exactly once (calls=${delegates.length}, finishReason=${result.finishReason})`
        )
      };
    }
    const call = delegates[0];
    // Already schema-validated by the SDK against the tool's `inputSchema`.
    return { ok: true, proposal: call.input as DecompositionProposal };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Run Phase 1 against the continuous Session: append the user turn, let the model
 * delegate over the indexed history, validate its call against the catalog, and
 * persist the reply to the Session.
 *
 * Both the user turn and the reply use deterministic ids, so a Workflow-step
 * re-run neither duplicates the turn nor changes an already-delivered reply.
 *
 * Throws only on a transient platform fault (for the Workflow step to retry);
 * every deterministic failure — a schema violation, a bad DAG, no `delegate` call,
 * both models exhausted — resolves to `{ status: "failed" }`.
 */
export async function runDecompose(
  args: RunDecomposeArgs
): Promise<DecomposeOutcome> {
  const { session, taskId, text, systemSuffix, models } = args;

  await appendOnce(
    session,
    deterministicSessionMessage(taskUserMessageId(taskId), "user", text)
  );

  const history = await session.getHistory();
  const { messages, catalog } = renderDecompositionMessages(history);
  const system =
    (await session.refreshSystemPrompt()) +
    systemSuffix +
    DECOMPOSITION_INSTRUCTIONS;

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
      console.warn("[decompose] model attempt failed", {
        model: modelId,
        error: String(outcome.error)
      });
      continue;
    }

    let resolved: ReturnType<typeof resolveDecomposition>;
    try {
      // Validation failure counts as an attempt failure: the other model gets a
      // chance to produce a usable graph before the Task fails. Scoped tightly to
      // the validation itself — a Session write is not a model problem, and must
      // not be retried against the fallback or reported as bad model output.
      resolved = resolveDecomposition(outcome.proposal, catalog);
    } catch (error) {
      errors.push(error);
      diagnostics.push(`${slot} (${modelId}): ${String(error)}`);
      console.warn("[decompose] invalid decomposition", {
        model: modelId,
        error: String(error)
      });
      continue;
    }

    // A throw here is a storage fault: it propagates so the Workflow step retries.
    const stored = await appendOnce(
      session,
      deterministicSessionMessage(
        decomposeReplyMessageId(taskId),
        "assistant",
        resolved.reply
      )
    );
    return { status: "completed", reply: stored, drafts: resolved.drafts };
  }

  // A transient fault is not a decomposition failure — let the step retry rather
  // than failing the user's Task over Workers-AI capacity.
  const transient = errors.find((e) => isTransientAiError(e));
  if (transient) throw transient;

  return {
    status: "failed",
    error: `decomposition exhausted both models — ${diagnostics.join("; ")}`
  };
}
