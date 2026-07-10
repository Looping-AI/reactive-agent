import type { SessionMessage } from "agents/experimental/memory/session";
import type { Embed } from "./model";
import { parseTurn, sessionText } from "./history";
import { RECALL_METADATA_TEXT_MAX, RECALL_TOP_K } from "@/config";

/**
 * Episodic recall over Cloudflare Vectorize. Ported from the looping-gateway
 * admin agent's `shared/recall.ts`.
 *
 * When the Session compacts, the raw messages it folds into a summary would
 * otherwise be lost. {@link archiveMessages} embeds that displaced range and
 * upserts it into Vectorize — namespaced per Durable Object instance — so the
 * `recall` tool ({@link file://./tools.ts}) can later semantically search history
 * that has scrolled out of the live context window.
 *
 * The namespace is always bound in code from the caller's verified identity
 * (never model input), so one caller can never read another's archive. Pure
 * logic is split from the binding: these functions take a {@link RecallIndex}
 * and an {@link Embed} fn as arguments so they unit-test without `env`.
 */

/** The subset of the Vectorize binding recall drives (structurally satisfied by `Vectorize`/`VectorizeIndex`). */
export interface RecallIndex {
  query(
    vector: number[],
    options?: VectorizeQueryOptions
  ): Promise<VectorizeMatches>;
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
}

/** A single archived message returned by a recall search. */
export interface RecallResult {
  score: number;
  role: string;
  /** The stored message snippet (truncated to {@link RECALL_METADATA_TEXT_MAX}). */
  text: string;
  /** Display name of the human speaker, when the message carried a `<turn>` wrapper. */
  author?: string;
  /** Slack user id of the speaker, when present. */
  authorId?: string;
  /** Channel the turn came from, when present. */
  channel?: string;
  /** ISO-8601 instant of the turn, when present. */
  at?: string;
}

/**
 * Build the Vectorize vectors for a batch of archived messages. Pure: `embeddings`
 * are supplied 1:1 with `messages` (both already filtered to non-empty text). The
 * vector `id` is the message's own id so re-archiving on a compaction retry is an
 * idempotent upsert; `<turn>` provenance is lifted into metadata when present.
 */
export function toRecallVectors(
  messages: SessionMessage[],
  namespace: string,
  embeddings: number[][]
): VectorizeVector[] {
  return messages.map((m, i) => {
    const text = sessionText(m);
    const metadata: Record<string, VectorizeVectorMetadata> = {
      role: m.role,
      text: text.slice(0, RECALL_METADATA_TEXT_MAX)
    };
    const turn = parseTurn(text);
    if (turn) {
      metadata.author = turn.from;
      metadata.authorId = turn.id;
      metadata.channel = turn.channel;
      metadata.at = turn.at;
    }
    return { id: m.id, namespace, values: embeddings[i], metadata };
  });
}

/**
 * Archive a range of displaced messages into Vectorize. Embeds the non-empty
 * texts in one batch and upserts them under `namespace`. No-op on empty input.
 * The caller ({@link file://./session.ts} `onArchive`) swallows failures so
 * compaction still shortens history if the recall store is briefly unavailable.
 */
export async function archiveMessages(
  index: RecallIndex,
  namespace: string,
  messages: SessionMessage[],
  embed: Embed
): Promise<void> {
  const withText = messages.filter((m) => sessionText(m).trim().length > 0);
  if (withText.length === 0) return;
  const embeddings = await embed(withText.map((m) => sessionText(m)));
  await index.upsert(toRecallVectors(withText, namespace, embeddings));
}

/**
 * Semantically search this instance's archive. Embeds the query and returns the
 * top matches within `namespace`, mapping each vector's metadata to a compact
 * {@link RecallResult}. Constrained to `namespace` — never a caller-supplied one.
 */
export async function recallSearch(
  index: RecallIndex,
  namespace: string,
  query: string,
  embed: Embed,
  topK: number = RECALL_TOP_K
): Promise<RecallResult[]> {
  const [vector] = await embed([query]);
  if (!vector) return [];
  const { matches } = await index.query(vector, {
    namespace,
    topK,
    returnMetadata: "all"
  });
  return matches.map((match) => {
    const md = (match.metadata ?? {}) as Record<string, string>;
    const result: RecallResult = {
      score: match.score,
      role: md.role ?? "unknown",
      text: md.text ?? ""
    };
    if (md.author) result.author = md.author;
    if (md.authorId) result.authorId = md.authorId;
    if (md.channel) result.channel = md.channel;
    if (md.at) result.at = md.at;
    return result;
  });
}
