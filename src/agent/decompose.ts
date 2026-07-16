import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { generateText, Output, stepCountIs } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { MAX_STEPS, MAX_SUBTASKS } from "@/config";
import { buildIntermediateContentHandler, isTransientAiError } from "./loop";
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
import {
  decompositionProposalSchema,
  resolveDecomposition
} from "./subtasks/decomposition";
import type { ModelPair } from "./model";
import type { DecompositionProposal, SubtaskDraft } from "./subtasks/types";

/**
 * Phase 1: turn one inbound task into a validated 1..8-node Subtask DAG plus the
 * first user-visible reply.
 *
 * Deliberately **not** an extension of {@link file://./loop.ts runTurn}: this has a
 * different output contract (structured, schema-validated), a different failure
 * contract (a typed failure fails the parent Task — it never resolves to a
 * friendly string), and different Session semantics (deterministic, replay-safe
 * message ids). It reuses what genuinely is shared: the model pair and manual
 * fallback shape, the tool set, the history conversion, and the intermediate
 * content handler.
 *
 * The model reasons over the whole conversation but delegates by **catalog index
 * only** — see {@link renderDecompositionMessages}.
 */

/** Prompt suffix teaching the decomposition contract. Appended to the soul + caller context. */
export const DECOMPOSITION_INSTRUCTIONS = `

# Task decomposition

You are decomposing the latest user request into durable subtasks that isolated
subagents will execute concurrently. Respond with JSON matching the required
schema — no prose outside it.

Produce:

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
where output genuinely feeds input.`;

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
  onContent?: (text: string, stepIndex: number) => void | Promise<void>;
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
 * One structured-output attempt against a single model.
 *
 * Takes the model **factory**, not a model: resolving it can throw (a missing
 * binding, a bad id), and that has to count as this attempt failing so the other
 * model still gets its turn.
 *
 * `result.output` is likewise read **inside** the try: the AI SDK surfaces the two
 * structured-output failures differently — unparseable or schema-mismatched final
 * text rejects `generateText` itself (`NoObjectGeneratedError`), while a run that
 * never produced a final object (truncated, or the step cap cut the tool loop
 * mid-flight) throws `NoOutputGeneratedError` on property access. Catching both
 * here collapses every attempt failure into one path.
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
      tools: args.tools,
      output: Output.object({ schema: decompositionProposalSchema }),
      stopWhen: stepCountIs(MAX_STEPS),
      // We do our own primary → fallback recovery, so disable the SDK's
      // per-model backoff (it would only add latency and duplicate the fallback).
      maxRetries: 0,
      onStepFinish: args.onContent
        ? buildIntermediateContentHandler(args.onContent)
        : undefined
    });
    return { ok: true, proposal: result.output };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Run Phase 1 against the continuous Session: append the user turn, ask the model
 * for a structured decomposition over the indexed history, validate it against the
 * catalog, and persist the reply to the Session.
 *
 * Both the user turn and the reply use deterministic ids, so a Workflow-step
 * re-run neither duplicates the turn nor changes an already-delivered reply.
 *
 * Throws only on a transient platform fault (for the Workflow step to retry);
 * every deterministic failure — invalid JSON, schema violation, a bad DAG, both
 * models exhausted — resolves to `{ status: "failed" }`.
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
