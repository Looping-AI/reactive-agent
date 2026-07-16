import type { SessionMessage } from "agents/experimental/memory/session";
import { isCompactionMessage } from "agents/experimental/memory/utils";
import { sessionText } from "@/agent/history";
import type { SubtaskReference } from "./types";

/**
 * One entry of the ephemeral, per-decomposition reference catalog: a verbatim
 * `user`/`assistant` turn plus the 1-based index the decomposition model selects
 * it by. Structurally a {@link SubtaskReference} with an `index`, so selecting an
 * entry and snapshotting it onto a Subtask (C1) is a plain subset copy.
 */
export interface ReferenceCatalogEntry extends SubtaskReference {
  /** 1-based, ephemeral, per-decomposition index the model references. */
  index: number;
}

/**
 * Whether a history message is a referenceable turn: a verbatim `user` or
 * `assistant` turn with actual content.
 *
 * Compaction summaries are excluded via the SDK's `isCompactionMessage` (their
 * `compaction_` id prefix) — they are generated text, never original conversation
 * evidence. Whitespace-only turns are excluded because there is nothing to
 * reference.
 *
 * This is the single eligibility rule: {@link buildReferenceCatalog} numbers the
 * messages it accepts, and the decomposition prompt renderer marks exactly those
 * messages with their `[ref N]` index. Sharing one predicate is what keeps the
 * marked messages and the catalog indices aligned — the two walk the same history
 * and must agree on which messages count.
 */
export function isCatalogEligible(message: SessionMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (isCompactionMessage(message)) return false;
  return sessionText(message).trim().length > 0;
}

/**
 * Turn the live Session history into a numbered reference catalog for Phase 1
 * decomposition. Pure and ephemeral: no persistence, no IDs, no Session mutation.
 *
 * Only verbatim `user` and `assistant` turns are eligible and they are numbered
 * `1..N` in history order. Compaction summaries are excluded via the SDK's
 * `isCompactionMessage` (their `compaction_` id prefix); recall results, system
 * prompts, and context blocks never appear as plain history messages here, so
 * they are excluded structurally. Whitespace-only turns are skipped — there is
 * nothing to reference, and since the model only ever selects from the catalog
 * we return, skipping them cannot misalign indices.
 *
 * The inbound user turn has already been appended to the Session (C1 step 1), so
 * one catalog covers both the current task input and past turns. The selected
 * entries' exact text is snapshotted onto the Subtask at decomposition, so
 * nothing is resolved lazily and later compaction cannot affect a Subtask in
 * flight.
 */
export function buildReferenceCatalog(
  history: SessionMessage[]
): ReferenceCatalogEntry[] {
  const catalog: ReferenceCatalogEntry[] = [];
  let index = 0;
  for (const message of history) {
    if (!isCatalogEligible(message)) continue;
    catalog.push({
      index: ++index,
      role: message.role as "user" | "assistant",
      text: sessionText(message)
    });
  }
  return catalog;
}
