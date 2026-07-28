import { describe, it, expect } from "vitest";
import { asSchema } from "ai";
import {
  decompositionProposalSchema,
  DecompositionValidationError,
  resolveDecomposition
} from "@/agent/subtasks/decomposition";
import { delegateTool } from "@/agent/subtasks/delegate";
import type { ReferenceCatalogEntry } from "@/agent/subtasks/catalog";
import type {
  DecompositionProposal,
  SubtaskProposal
} from "@/agent/subtasks/types";
import { SUBTASK_TYPE_SPECS } from "@/recipes";

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
      type: "general",
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
  it("trims the reply and prompt", () => {
    const p = proposal({ prompt: "  do it  " });
    p.reply = "  On it.  ";
    const { reply, drafts } = resolveDecomposition(p, CATALOG);
    expect(reply).toBe("On it.");
    expect(drafts[0].prompt).toBe("do it");
  });

  it("carries a type's params onto the draft", () => {
    const { drafts } = resolveDecomposition(
      proposal({
        type: "arc-game",
        params: { card_id: "card-1", game_id: "ls20-abc" }
      }),
      CATALOG
    );
    expect(drafts[0].params).toEqual({
      card_id: "card-1",
      game_id: "ls20-abc"
    });
  });

  it("defaults to empty params for a type that takes none", () => {
    const { drafts } = resolveDecomposition(proposal({}), CATALOG);
    expect(drafts[0].params).toEqual({});
  });

  it("rejects a subtask missing the params its type requires", () => {
    // Shape only — that the card exists and is open is a question for durable
    // rows, answered when the execution starts.
    expect(() =>
      resolveDecomposition(proposal({ type: "arc-game" }), CATALOG)
    ).toThrow(/invalid params/);
  });

  it("names the offending subtask, since one bad entry fails the attempt", () => {
    expect(() =>
      resolveDecomposition(proposal({}, { type: "arc-game" }), CATALOG)
    ).toThrow(/subtask k1/);
  });

  it("rejects a type outside the known set", () => {
    // The enum keeps invented types out of the model's own calls; this is the
    // guard for anything that reaches resolveDecomposition another way.
    expect(() =>
      resolveDecomposition(proposal({ type: "research" }), CATALOG)
    ).toThrow(/unknown subtask type/);
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

/**
 * The schema as the **provider** receives it, not as zod declares it — and the
 * gap between those two is the reason this block exists.
 *
 * JSON Schema spends one slot, `additionalProperties`, on two unrelated jobs: a
 * record's value type, and the strict-mode "no other keys" flag. The AI SDK's
 * conversion writes `false` into it unconditionally, so `z.record(z.string(),
 * z.string())` — correct in zod, and correct in zod's own JSON Schema output —
 * reaches the model as an object that permits **no keys at all**. That shipped,
 * and a Task failed on an `arc-game` subtask with no `card_id`: the model's
 * reasoning said it was passing one, and the schema gave it nowhere to put it.
 *
 * So these assertions deliberately run on the converted output. Anything checked
 * against the zod schema alone would have passed on the broken version too.
 */
describe("the delegate tool's schema, as converted for the provider", () => {
  interface WireSchema {
    type?: string;
    description?: string;
    pattern?: string;
    properties?: Record<string, WireSchema>;
    items?: WireSchema;
    additionalProperties?: boolean | WireSchema;
  }

  function paramsWireSchema(): WireSchema {
    const root = asSchema(delegateTool.inputSchema).jsonSchema as WireSchema;
    const params = root.properties?.subtasks?.items?.properties?.params;
    if (!params)
      throw new Error("delegate schema exposes no subtasks[].params");
    return params;
  }

  /** Every key any type declares — the union the one flat `params` must cover. */
  const declaredKeys = [
    ...new Set(
      SUBTASK_TYPE_SPECS.flatMap((spec) =>
        spec.params ? Object.keys(spec.params.shape) : []
      )
    )
  ];

  it("names every param key any type declares", () => {
    // Sanity: a manifest with no params at all would make this vacuous.
    expect(declaredKeys).toContain("card_id");
    expect(Object.keys(paramsWireSchema().properties ?? {}).sort()).toEqual(
      declaredKeys.sort()
    );
  });

  it("never advertises an object that permits no keys", () => {
    // The exact broken shape: `additionalProperties: false` with nothing in
    // `properties` is unsatisfiable — the model cannot send params at all.
    const params = paramsWireSchema();
    if (params.additionalProperties === false) {
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("tells the model which type each key belongs to", () => {
    // A flat namespace across types is only usable if each key says whose it is.
    const properties = paramsWireSchema().properties ?? {};
    for (const [key, field] of Object.entries(properties)) {
      const owners = SUBTASK_TYPE_SPECS.filter(
        (spec) => spec.params && key in spec.params.shape
      );
      expect(field.description).toContain(owners[0].key);
    }
  });

  it("still describes how to obtain each param", () => {
    // The prose from the type's own declaration survives the type prefix.
    expect(paramsWireSchema().properties?.card_id?.description).toContain(
      "arc_open_scorecard"
    );
    expect(paramsWireSchema().properties?.game_id?.description).toContain(
      "arc_list_games"
    );
  });

  it("shows the model the not-blank rule on every field that enforces it", () => {
    // The same class of gap as `params` above, one level subtler: a `.refine()`
    // is enforced by the SDK's validation but converts to nothing, so a
    // whitespace-only value would fail the call over a rule the schema never
    // stated. Expressed as a pattern, it is on the wire — no `.describe()`
    // needed to restate it, and none of these fields has one.
    const root = asSchema(delegateTool.inputSchema).jsonSchema as WireSchema;
    const subtask = root.properties?.subtasks?.items;
    const nonBlankFields: [string, WireSchema | undefined][] = [
      ["reply", root.properties?.reply],
      ["localKey", subtask?.properties?.localKey],
      ["prompt", subtask?.properties?.prompt],
      ["dependsOn entry", subtask?.properties?.dependsOn?.items]
    ];
    for (const [label, field] of nonBlankFields) {
      expect(field, `delegate schema exposes no ${label}`).toBeDefined();
      // A pattern that a whitespace-only string cannot satisfy.
      expect(field?.pattern, label).toBeDefined();
      expect(new RegExp(field!.pattern!).test("   "), label).toBe(false);
      expect(new RegExp(field!.pattern!).test("do the thing"), label).toBe(
        true
      );
    }
  });
});
