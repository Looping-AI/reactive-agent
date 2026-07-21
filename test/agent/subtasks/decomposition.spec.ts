import { describe, it, expect } from "vitest";
import {
  decompositionProposalSchema,
  DecompositionValidationError,
  resolveDecomposition
} from "@/agent/subtasks/decomposition";
import type { ReferenceCatalogEntry } from "@/agent/subtasks/catalog";
import type {
  DecompositionProposal,
  SubtaskProposal
} from "@/agent/subtasks/types";

/** A three-entry catalog: the indices the model would select from. */
const CATALOG: ReferenceCatalogEntry[] = [
  { index: 1, role: "user", text: '<turn from="Ada">book me a flight</turn>' },
  { index: 2, role: "assistant", text: "Which dates?" },
  { index: 3, role: "user", text: '<turn from="Ada">March 3rd</turn>' }
];

function proposal(
  ...subtasks: Partial<SubtaskProposal>[]
): DecompositionProposal {
  return {
    reply: "On it.",
    subtasks: subtasks.map((s, i) => ({
      localKey: `k${i}`,
      type: "research",
      prompt: "do the thing",
      referenceIndexes: [],
      dependsOn: [],
      ...s
    }))
  };
}

describe("resolveDecomposition — reference snapshotting", () => {
  it("copies the catalog entry's exact role and text onto the draft", () => {
    const { drafts } = resolveDecomposition(
      proposal({ referenceIndexes: [1, 2] }),
      CATALOG
    );
    expect(drafts[0].references).toEqual([
      { role: "user", text: CATALOG[0].text },
      { role: "assistant", text: "Which dates?" }
    ]);
  });

  it("stores selected indexes ascending regardless of the order given", () => {
    const { drafts } = resolveDecomposition(
      proposal({ referenceIndexes: [3, 1] }),
      CATALOG
    );
    expect(drafts[0].references.map((r) => r.text)).toEqual([
      CATALOG[0].text,
      CATALOG[2].text
    ]);
  });

  it("rejects an index past the end of the catalog", () => {
    expect(() =>
      resolveDecomposition(proposal({ referenceIndexes: [4] }), CATALOG)
    ).toThrow(DecompositionValidationError);
  });

  it("rejects the same index selected twice", () => {
    expect(() =>
      resolveDecomposition(proposal({ referenceIndexes: [2, 2] }), CATALOG)
    ).toThrow(/more than once/);
  });

  it("accepts a subtask that references nothing", () => {
    const { drafts } = resolveDecomposition(proposal({}), CATALOG);
    expect(drafts[0].references).toEqual([]);
  });

  it("accepts a call that omits referenceIndexes entirely", () => {
    // The field is optional because this one schema also describes the calls
    // reconstructed from durable rows in later rounds, whose references were
    // resolved to snapshots and no longer have indices.
    const call = proposal({});
    delete call.subtasks[0].referenceIndexes;

    expect(decompositionProposalSchema.safeParse(call).success).toBe(true);
    expect(resolveDecomposition(call, CATALOG).drafts[0].references).toEqual(
      []
    );
  });
});

describe("resolveDecomposition — dependency graph", () => {
  it("preserves array order (the data layer derives ordinal from it)", () => {
    const { drafts } = resolveDecomposition(
      proposal({ localKey: "a" }, { localKey: "b" }, { localKey: "c" }),
      CATALOG
    );
    expect(drafts.map((d) => d.localKey)).toEqual(["a", "b", "c"]);
  });

  it("accepts an edge pointing forward to a later subtask", () => {
    const { drafts } = resolveDecomposition(
      proposal({ localKey: "a", dependsOn: ["b"] }, { localKey: "b" }),
      CATALOG
    );
    expect(drafts[0].dependsOn).toEqual(["b"]);
  });

  it("rejects a duplicate local key", () => {
    expect(() =>
      resolveDecomposition(
        proposal({ localKey: "same" }, { localKey: "same" }),
        CATALOG
      )
    ).toThrow(/duplicate subtask local key/);
  });

  it("rejects an edge to an unknown key", () => {
    expect(() =>
      resolveDecomposition(
        proposal({ localKey: "a", dependsOn: ["ghost"] }),
        CATALOG
      )
    ).toThrow(/unknown key/);
  });

  it("rejects a self-dependency", () => {
    expect(() =>
      resolveDecomposition(
        proposal({ localKey: "a", dependsOn: ["a"] }),
        CATALOG
      )
    ).toThrow(/depends on itself/);
  });

  it("rejects a duplicate edge", () => {
    expect(() =>
      resolveDecomposition(
        proposal({ localKey: "a", dependsOn: ["b", "b"] }, { localKey: "b" }),
        CATALOG
      )
    ).toThrow(/more than once/);
  });

  it("rejects a two-node cycle", () => {
    expect(() =>
      resolveDecomposition(
        proposal(
          { localKey: "a", dependsOn: ["b"] },
          { localKey: "b", dependsOn: ["a"] }
        ),
        CATALOG
      )
    ).toThrow(/cycle/);
  });

  it("rejects a three-node cycle", () => {
    expect(() =>
      resolveDecomposition(
        proposal(
          { localKey: "a", dependsOn: ["c"] },
          { localKey: "b", dependsOn: ["a"] },
          { localKey: "c", dependsOn: ["b"] }
        ),
        CATALOG
      )
    ).toThrow(/cycle/);
  });

  it("accepts a diamond (fan-out then fan-in)", () => {
    const { drafts } = resolveDecomposition(
      proposal(
        { localKey: "root" },
        { localKey: "left", dependsOn: ["root"] },
        { localKey: "right", dependsOn: ["root"] },
        { localKey: "join", dependsOn: ["left", "right"] }
      ),
      CATALOG
    );
    expect(drafts).toHaveLength(4);
    expect(drafts[3].dependsOn).toEqual(["left", "right"]);
  });
});

describe("resolveDecomposition — field hygiene", () => {
  it("trims the reply, type, and prompt", () => {
    const p = proposal({ type: "  research  ", prompt: "  do it  " });
    p.reply = "  On it.  ";
    const { reply, drafts } = resolveDecomposition(p, CATALOG);
    expect(reply).toBe("On it.");
    expect(drafts[0].type).toBe("research");
    expect(drafts[0].prompt).toBe("do it");
  });
});

describe("decompositionProposalSchema", () => {
  it("accepts a well-formed proposal", () => {
    expect(
      decompositionProposalSchema.safeParse(proposal({ referenceIndexes: [1] }))
        .success
    ).toBe(true);
  });

  it("rejects zero subtasks", () => {
    expect(
      decompositionProposalSchema.safeParse({ reply: "hi", subtasks: [] })
        .success
    ).toBe(false);
  });

  it("rejects more than eight subtasks", () => {
    const nine = proposal(
      ...Array.from({ length: 9 }, (_, i) => ({
        localKey: `k${i}`
      }))
    );
    expect(decompositionProposalSchema.safeParse(nine).success).toBe(false);
  });

  it("accepts exactly eight subtasks", () => {
    const eight = proposal(
      ...Array.from({ length: 8 }, (_, i) => ({
        localKey: `k${i}`
      }))
    );
    expect(decompositionProposalSchema.safeParse(eight).success).toBe(true);
  });

  it("rejects a blank reply", () => {
    const p = proposal({});
    p.reply = "   ";
    expect(decompositionProposalSchema.safeParse(p).success).toBe(false);
  });

  it("rejects a blank prompt (it would only fail later, inside the child)", () => {
    expect(
      decompositionProposalSchema.safeParse(proposal({ prompt: "  " })).success
    ).toBe(false);
  });

  it("rejects a zero or negative reference index", () => {
    expect(
      decompositionProposalSchema.safeParse(proposal({ referenceIndexes: [0] }))
        .success
    ).toBe(false);
  });

  it("rejects a non-integer reference index", () => {
    expect(
      decompositionProposalSchema.safeParse(
        proposal({ referenceIndexes: [1.5] })
      ).success
    ).toBe(false);
  });
});
