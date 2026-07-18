/**
 * Model + tool-loop constants for the agent runtime. Hardcoded (not env vars) to
 * mirror the looping-gateway admin agent; swap the ids here to change models.
 */

/** Workers AI model used by the agent tool loop. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/zai-org/glm-5.2";

/** Fallback model tried when the primary model throws an error. */
export const CHAT_FALLBACK_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/** Upper bound on tool-loop steps in a single turn (bounds the `generateText` loop). */
export const MAX_STEPS = 8;

/**
 * Default recipe execution limits (see `ResolvedRecipe.limits`). The default
 * recipe runs `maxTurns === turnsPerChunk === MAX_STEPS`, so it always completes
 * in a single durable chunk — byte-identical to the pre-resumable-runner
 * behavior. Long-running recipes (e.g. game play) raise `maxTurns` far above
 * `turnsPerChunk` so the run spans many chunks, each a fresh, retryable Workflow
 * step well under the platform's ~10-minute step timeout.
 */
export const DEFAULT_MAX_TURNS = MAX_STEPS;
export const DEFAULT_TURNS_PER_CHUNK = MAX_STEPS;
export const DEFAULT_CHUNK_SOFT_MS = 4 * 60_000;

/**
 * Default number of most-recent turns kept verbatim in a resumable run's rolling
 * model context. Large enough that a single-chunk (`MAX_STEPS`) run never prunes;
 * long recipes keep it small and lean on the workspace for durable memory.
 */
export const DEFAULT_HISTORY_WINDOW = 64;

/**
 * Hard cap on durable chunk steps the Workflow will run for one Subtask branch
 * before failing it. Bounds `runBranch`'s chunk loop against the Cloudflare
 * Workflows per-instance step ceiling (10,000 on the paid plan): even at the
 * longest recipe (`maxTurns / turnsPerChunk` chunks, plus one level-up-ended
 * chunk per progress event) this stays comfortably under the platform limit.
 */
export const MAX_CHUNKS_PER_BRANCH = 1500;

/**
 * Upper bound on Subtasks per parent Task — a Core Invariant: every accepted Task
 * decomposes into 1..8 Subtasks, which is also what bounds Phase 2 fan-out (all
 * dependency-ready Subtasks run concurrently, with no other concurrency cap).
 *
 * Enforced at both ends: the decomposition schema constrains the model's output,
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
