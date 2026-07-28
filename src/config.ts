/**
 * Model + tool-loop constants for the agent runtime. Hardcoded (not env vars) to
 * mirror the looping-gateway admin agent; swap the ids here to change models.
 */

// Type-only, and outward-flowing like every other `recipes/` type: the shape is
// owned by the domain layer, the baseline value is owned here.
import type { RecipeLimits } from "@/recipes/types";

/** Workers AI model used by the agent tool loop. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/**
 * Fallback model tried when the primary model throws an error. Deliberately a
 * *different vendor and family* from {@link CHAT_MODEL_ID}.
 */
export const CHAT_FALLBACK_MODEL_ID = "@cf/zai-org/glm-5.2";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/**
 * Output-token ceiling for every chat call. Left unset, the binding applies its own
 * per-model default, which on a reasoning model is spent on `reasoning_content`
 * before the tool call is ever emitted — a truncated round that reads as a clean
 * answer. Generous on purpose: the ceiling exists to bound a runaway, not to
 * ration, and both slots have >=131k of context to draw on.
 */
export const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Reasoning budget for the reasoning-capable chat models. Forwarded on the
 * binding's `inputs` object by `workers-ai-provider` (see `chatSettings`).
 */
export const REASONING_EFFORT = "medium" as const;

/**
 * The execution budget, in the only two currencies that mean anything:
 * **turns** (what it costs) and **wall clock** (how long it can run away for).
 * Two levels — the main agent for a whole Task, and one subagent branch — and
 * nothing else in this repo is a budget.
 *
 * Rounds, chunks and steps are *mechanics*: a round is the delegate/answer loop,
 * a chunk is a durable slice sized by the Workers step timeout (see
 * {@link file://./platform.ts}). None of them is tunable and none of them belongs
 * here. Presenting them as budgets is what made an overnight runaway look, to
 * every cap in the codebase, like a healthy Task.
 *
 * Reaching either ceiling at either level does the same thing: one final call
 * with **no tools** — "you have spent your budget, answer now from what you
 * have". A ceiling yields an answer; it never drops the work.
 */

/** What bounds the MAIN agent across every round of one Task. */
export const MAIN_AGENT_LIMITS = {
  /**
   * Tool-loop steps summed across every round *and* across the primary→fallback
   * attempt within a round — a fallback attempt is real spend.
   */
  maxTurns: 20,
  /**
   * Measured from the Task's first durable step. Note for whoever implements
   * escalation: this must be **rebased** after a `step.waitForEvent(...)`
   * returns, or a human's thinking time is charged to the agent and a Task that
   * asks a question at minute 5 is dead before the answer arrives. Turns need no
   * such care — waiting costs none.
   */
  maxWallMs: 60 * 60_000
} as const;

/**
 * The baseline every subagent branch runs under. A Recipe may override either
 * field — to any positive integer, larger included — and inherits the baseline for
 * whatever it does not validly declare; see `resolveLimits` in
 * {@link file://./recipes/validation.ts}. A default, not a ceiling.
 */
export const SUBAGENT_LIMITS: RecipeLimits = {
  maxTurns: 20,
  maxWallMs: 30 * 60_000
};

/**
 * Upper bound on Subtasks per **round** — a Core Invariant: a delegating round
 * emits 1..8 Subtasks, which is also what bounds its fan-out (all
 * dependency-ready Subtasks run concurrently, with no other concurrency cap).
 *
 * Not a budget but a shape: it is what the delegation schema offers the model,
 * and the data layer re-checks it as the durable guard.
 */
export const MAX_SUBTASKS = 8;

/**
 * Sessions memory + compaction tuning (mirrors the admin agent's values).
 *
 * The agent keeps one continuous {@link file://./session.ts Session} per caller:
 * a writable `"memory"` scratchpad it self-edits, plus history that is compacted
 * (summarized) automatically once it grows past {@link COMPACT_AFTER_TOKENS}.
 */

/** Soft cap (tokens) for the self-edited `"memory"` scratchpad block. */
export const MEMORY_MAX_TOKENS = 1200;

/** Live-history token threshold that triggers automatic (size-based) compaction. */
export const COMPACT_AFTER_TOKENS = 60_000;

/** One-line description shown to the model for the writable `"memory"` block. */
export const MEMORY_DESCRIPTION =
  "Durable facts worth remembering across all of this caller's conversations — " +
  "stable preferences, decisions, people, and context. Keep it concise.";

/**
 * Episodic recall (Vectorize) tuning.
 *
 * When history is compacted, the raw messages it displaces are embedded and
 * stored in Vectorize (namespaced per Durable Object instance). A `recall` tool
 * lets the model semantically search that archive for history that has scrolled
 * out of the live context window. See {@link file://./agent/recall.ts}.
 */

/**
 * Workers AI text-embedding model backing recall. Its output dimension/metric
 * must match the Vectorize index (`--dimensions=1024 --metric=cosine`); changing
 * it means recreating the index.
 */
export const EMBEDDING_MODEL_ID = "@cf/baai/bge-m3";

/** Default number of archived messages a single `recall` query returns. */
export const RECALL_TOP_K = 5;

/**
 * Max chars of a message's text stored in its Vectorize vector metadata. Keeps
 * each vector's metadata under Vectorize's ~10 KiB/vector limit; recall returns
 * this snippet plus provenance, not the full original message.
 */
export const RECALL_METADATA_TEXT_MAX = 2000;
