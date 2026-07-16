import { z } from "zod";
import { MAX_SUBTASKS } from "@/config";
import type { ReferenceCatalogEntry } from "./catalog";
import type {
  DecompositionProposal,
  SubtaskDraft,
  SubtaskReference
} from "./types";

/**
 * Pure validation and resolution of the decomposition model's output (Phase 1).
 * No model, no Session, no database — given a {@link DecompositionProposal} and
 * the ephemeral reference catalog it was generated against, this either produces
 * the drafts to persist or throws.
 *
 * Two invariants live here:
 *
 * - **The model selects references by index only.** It emits catalog indices; this
 *   module copies the catalog entry's exact role+text onto the draft. Model output
 *   never becomes reference text, so a Subtask cannot carry a rewritten,
 *   summarized, or fabricated "quote" of the conversation.
 * - **The dependency graph is a validated DAG.** Unknown, duplicate,
 *   self-referential, and cyclic edges are all rejected here. The data layer's
 *   `createDecomposition` re-checks the cheap structural rules as a storage guard,
 *   but full cycle detection is this module's job.
 *
 * Invalid output is never repaired: a throw fails the attempt, which falls back to
 * the other model, and two failed attempts fail the parent Task. Silently
 * synthesizing a general Subtask would deliver plausible work the user never asked
 * for.
 */

/** A model proposal that cannot be resolved into a valid decomposition. */
export class DecompositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompositionValidationError";
  }
}

const nonBlank = (label: string) =>
  z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, {
      message: `${label} must not be blank`
    });

const subtaskProposalSchema = z.object({
  localKey: nonBlank("localKey"),
  type: nonBlank("type"),
  prompt: nonBlank("prompt"),
  referenceIndexes: z.array(z.number().int().min(1)),
  dependsOn: z.array(nonBlank("dependsOn entry"))
});

/**
 * The structured-output schema handed to `Output.object()`. The 1..8 bound is
 * enforced here (the model is told it, and the SDK rejects output that breaks it)
 * and again in the data layer, which owns the durable invariant.
 *
 * Blank strings are rejected at the schema edge rather than deep in execution: an
 * empty `prompt` would otherwise burn a Subtask slot and only fail later, inside
 * the child, with no useful diagnostic.
 */
export const decompositionProposalSchema = z.object({
  reply: nonBlank("reply"),
  subtasks: z.array(subtaskProposalSchema).min(1).max(MAX_SUBTASKS)
});

/**
 * Reject an edge set that contains a cycle, by Kahn's algorithm over the
 * draft-local keys: repeatedly remove nodes with no unresolved prerequisites; if
 * any node survives, it is part of (or downstream of) a cycle.
 */
function assertAcyclic(proposal: DecompositionProposal): void {
  const remaining = new Map<string, Set<string>>(
    proposal.subtasks.map((s) => [s.localKey, new Set(s.dependsOn)])
  );
  let progressed = true;
  while (progressed && remaining.size > 0) {
    progressed = false;
    for (const [key, deps] of remaining) {
      // Ready when every prerequisite has already been removed.
      if ([...deps].every((d) => !remaining.has(d))) {
        remaining.delete(key);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) {
    throw new DecompositionValidationError(
      `dependency cycle among subtasks: ${[...remaining.keys()].join(", ")}`
    );
  }
}

/**
 * Snapshot the selected catalog entries onto a draft: validate every index against
 * the catalog, reject duplicates, and copy each entry's exact role+text. Indexes
 * are stored ascending so a Subtask's references read in conversation order
 * regardless of the order the model listed them.
 */
function resolveReferences(
  localKey: string,
  referenceIndexes: number[],
  catalog: ReferenceCatalogEntry[]
): SubtaskReference[] {
  const seen = new Set<number>();
  for (const index of referenceIndexes) {
    if (seen.has(index)) {
      throw new DecompositionValidationError(
        `subtask ${localKey} references index ${index} more than once`
      );
    }
    seen.add(index);
    if (index > catalog.length) {
      throw new DecompositionValidationError(
        `subtask ${localKey} references unknown catalog index ${index} ` +
          `(catalog has ${catalog.length} ${catalog.length === 1 ? "entry" : "entries"})`
      );
    }
  }
  return [...referenceIndexes]
    .sort((a, b) => a - b)
    .map((index) => {
      // The catalog is 1-based; copy role+text verbatim (never the model's words).
      const entry = catalog[index - 1];
      return { role: entry.role, text: entry.text };
    });
}

/**
 * Resolve a validated model proposal into the drafts to persist.
 *
 * Throws {@link DecompositionValidationError} on any structural problem: blank
 * fields, duplicate local keys, unknown/duplicate reference indices, and unknown,
 * duplicate, self-referential, or cyclic dependency edges. On success, array order
 * is preserved — the data layer derives each Subtask's `ordinal` from it.
 */
export function resolveDecomposition(
  proposal: DecompositionProposal,
  catalog: ReferenceCatalogEntry[]
): { reply: string; drafts: SubtaskDraft[] } {
  const keys = new Set<string>();
  for (const s of proposal.subtasks) {
    if (keys.has(s.localKey)) {
      throw new DecompositionValidationError(
        `duplicate subtask local key: ${s.localKey}`
      );
    }
    keys.add(s.localKey);
  }

  // Every key must be registered before any edge is checked: an edge may point
  // forward to a subtask defined later in the array.
  for (const s of proposal.subtasks) {
    const seen = new Set<string>();
    for (const dep of s.dependsOn) {
      if (dep === s.localKey) {
        throw new DecompositionValidationError(
          `subtask ${s.localKey} depends on itself`
        );
      }
      if (!keys.has(dep)) {
        throw new DecompositionValidationError(
          `subtask ${s.localKey} depends on unknown key: ${dep}`
        );
      }
      if (seen.has(dep)) {
        throw new DecompositionValidationError(
          `subtask ${s.localKey} depends on ${dep} more than once`
        );
      }
      seen.add(dep);
    }
  }

  assertAcyclic(proposal);

  const drafts: SubtaskDraft[] = proposal.subtasks.map((s) => ({
    localKey: s.localKey,
    type: s.type.trim(),
    prompt: s.prompt.trim(),
    references: resolveReferences(s.localKey, s.referenceIndexes, catalog),
    dependsOn: [...s.dependsOn]
  }));

  return { reply: proposal.reply.trim(), drafts };
}
