import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import { embedMany } from "ai";
import { env } from "cloudflare:workers";
import {
  AI_GATEWAY_ID,
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  EMBEDDING_MODEL_ID
} from "@/config";

// Lazily construct the provider on first use rather than at module load.
// During `wrangler deploy`, Cloudflare evaluates the top-level module scope to
// validate the new version, but bindings like `env.AI` are not populated at
// that point — reading it eagerly makes createWorkersAI throw with a
// "you must provide either a binding or credentials" error.
let _workersai: ReturnType<typeof createWorkersAI> | undefined;
function workersai() {
  return (_workersai ??= createWorkersAI({
    binding: env.AI,
    gateway: { id: AI_GATEWAY_ID }
  }));
}

/**
 * Embed a batch of texts for episodic recall. Uses the same Workers-AI + AI
 * Gateway path as the chat models so embeddings get the same gateway
 * observability/caching. The output dimension must match the Vectorize index.
 */
export type Embed = (texts: string[]) => Promise<number[][]>;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: workersai().embedding(EMBEDDING_MODEL_ID),
    values: texts,
    // We surface failures to the caller (best-effort archival swallows them);
    // the SDK's retry/backoff would only add latency on a hard failure.
    maxRetries: 0
  });
  return embeddings;
}

/**
 * Custom metadata attached to the AI Gateway log for every call this pair makes.
 * The gateway's own `metadata` is otherwise `null`, so a model call can only be
 * tied back to its Task by timestamp; stamping `{ taskId, round }` (a turn) or
 * `{ taskId, subtaskId }` (a chunk) makes `cf ai` correlation exact. Values are
 * limited to the gateway's accepted scalar set.
 */
export type GatewayMetadata = Record<
  string,
  number | string | boolean | null | bigint
>;

export interface ModelOverrides {
  model?: LanguageModel; // test override for the primary
  fallbackModel?: LanguageModel; // test override for the fallback
  /**
   * Workers-AI id for the primary slot (a Recipe's, already code-validated
   * against the allowlist by `validateRecipe`). Defaults to `CHAT_MODEL_ID`.
   */
  primaryModelId?: string;
  /**
   * Workers-AI id for the fallback slot (already code-validated). Defaults to
   * `CHAT_FALLBACK_MODEL_ID`.
   */
  fallbackModelId?: string;
  /** AI Gateway log metadata for correlation — see {@link GatewayMetadata}. */
  metadata?: GatewayMetadata;
}

/**
 * Per-model Workers-AI settings: pin the gateway id (so per-call metadata does
 * not drop the gateway route) and attach correlation metadata when supplied.
 * Returns `undefined` when there is no metadata so the provider default applies.
 */
function chatSettings(metadata?: GatewayMetadata) {
  return metadata ? { gateway: { id: AI_GATEWAY_ID, metadata } } : undefined;
}

/** The primary/fallback models (lazily memoized) plus their ids for logging. */
export interface ModelPair {
  primary: () => LanguageModel;
  fallback: () => LanguageModel;
  primaryId: () => string;
  fallbackId: () => string;
}

/**
 * Lazily build + memoize the primary/fallback model pair (overridable in
 * tests, id-parameterized for Recipes). No allowlisting happens here —
 * `validateRecipe` is the single validation owner for Recipe-supplied ids.
 */
export function createModelPair(overrides: ModelOverrides = {}): ModelPair {
  const primaryId = overrides.primaryModelId ?? CHAT_MODEL_ID;
  const fallbackId = overrides.fallbackModelId ?? CHAT_FALLBACK_MODEL_ID;
  let primary: LanguageModel | undefined;
  let fallback: LanguageModel | undefined;
  const settings = chatSettings(overrides.metadata);
  return {
    primary: () =>
      (primary ??= overrides.model ?? workersai()(primaryId, settings)),
    fallback: () =>
      (fallback ??=
        overrides.fallbackModel ??
        overrides.model ??
        workersai()(fallbackId, settings)),
    primaryId: () => primaryId,
    fallbackId: () => fallbackId
  };
}
