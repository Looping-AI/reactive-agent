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

/** The model used by the agent tool loop. */
export function chatModel(): LanguageModel {
  return workersai()(CHAT_MODEL_ID);
}

/** Fallback model used when the primary model is over capacity or errors. */
export function fallbackChatModel(): LanguageModel {
  return workersai()(CHAT_FALLBACK_MODEL_ID);
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

export interface ModelOverrides {
  model?: LanguageModel; // test override for the primary
  fallbackModel?: LanguageModel; // test override for the fallback
}

/** The primary/fallback models (lazily memoized) plus their ids for logging. */
export interface ModelPair {
  primary: () => LanguageModel;
  fallback: () => LanguageModel;
  primaryId: () => string;
  fallbackId: () => string;
}

/** Lazily build + memoize the primary/fallback model pair (overridable in tests). */
export function createModelPair(overrides: ModelOverrides = {}): ModelPair {
  let primary: LanguageModel | undefined;
  let fallback: LanguageModel | undefined;
  return {
    primary: () => (primary ??= overrides.model ?? chatModel()),
    fallback: () =>
      (fallback ??=
        overrides.fallbackModel ?? overrides.model ?? fallbackChatModel()),
    primaryId: () => CHAT_MODEL_ID,
    fallbackId: () => CHAT_FALLBACK_MODEL_ID
  };
}
