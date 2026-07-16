import { describe, it, expect } from "vitest";
import { selectWave } from "@/agent/subtasks/scheduler";
import type { SubtaskNode, SubtaskStatus } from "@/agent/subtasks/types";

/**
 * Unit coverage for the pure Phase 2 wave scheduler. No DO, no I/O — `selectWave`
 * is a plain function of the DAG's current statuses.
 */

let nextId = 0;

/** One node. `ordinal` follows creation order unless overridden. */
function node(
  status: SubtaskStatus,
  dependsOn: number[] = [],
  overrides: Partial<SubtaskNode> = {}
): SubtaskNode {
  const id = ++nextId;
  return { id, ordinal: id, status, dependsOn, ...overrides };
}

describe("selectWave — termination", () => {
  it("reports done when every node reached a terminal status", () => {
    const nodes = [
      node("completed"),
      node("failed"),
      node("skipped"),
      node("canceled")
    ];
    expect(selectWave(nodes)).toEqual({ kind: "done" });
  });

  it("reports done for an empty DAG", () => {
    expect(selectWave([])).toEqual({ kind: "done" });
  });
});

describe("selectWave — wave selection", () => {
  it("runs every independent node in one wave", () => {
    const a = node("pending");
    const b = node("pending");
    const c = node("pending");

    expect(selectWave([a, b, c])).toEqual({
      kind: "ready",
      ids: [a.id, b.id, c.id]
    });
  });

  it("holds a dependent back until its prerequisite completes", () => {
    const a = node("pending");
    const b = node("pending", [a.id]);

    // Wave 0: only the root is ready.
    expect(selectWave([a, b])).toEqual({ kind: "ready", ids: [a.id] });

    // Wave 1: the root succeeded, so the dependent unblocks.
    const done = { ...a, status: "completed" as const };
    expect(selectWave([done, b])).toEqual({ kind: "ready", ids: [b.id] });
  });

  it("releases a fan-in node only once every prerequisite completed", () => {
    const root = node("completed");
    const left = node("completed", [root.id]);
    const right = node("running", [root.id]);
    const join = node("pending", [left.id, right.id]);

    // `right` is still active, so the join waits — and `right` itself is ready.
    expect(selectWave([root, left, right, join])).toEqual({
      kind: "ready",
      ids: [right.id]
    });

    const bothDone = { ...right, status: "completed" as const };
    expect(selectWave([root, left, bothDone, join])).toEqual({
      kind: "ready",
      ids: [join.id]
    });
  });

  it("never releases a node whose prerequisite did not succeed", () => {
    // A dependency must be `completed`, not merely terminal: a dependent must
    // never run on a failed prerequisite's absent output. (`skipBlockedSubtasks`
    // is what normally retires this node; here it proves the readiness rule.)
    const failed = node("failed");
    const dependent = node("pending", [failed.id]);

    expect(selectWave([failed, dependent])).toEqual({
      kind: "stuck",
      active: [dependent.id]
    });
  });

  it("returns ready ids in ordinal order regardless of input order", () => {
    // The Workflow derives durable step names from these ids, and a step name is
    // a cache key — so the traversal producing them must be deterministic.
    const first = node("pending", [], { ordinal: 1 });
    const second = node("pending", [], { ordinal: 2 });
    const third = node("pending", [], { ordinal: 3 });

    const decision = selectWave([third, first, second]);
    expect(decision).toEqual({
      kind: "ready",
      ids: [first.id, second.id, third.id]
    });
  });
});

describe("selectWave — running nodes are re-runnable", () => {
  // `executeSubtask` accepts `pending` *or* `running` (its ambiguous-retry path
  // recovers from the child's fingerprint cache), so a row stranded `running` by
  // a crashed attempt must be re-offered rather than treated as inert.
  it("re-offers a node stranded running by a crashed attempt", () => {
    const stranded = node("running");
    expect(selectWave([stranded])).toEqual({
      kind: "ready",
      ids: [stranded.id]
    });
  });

  it("does not deadlock a dependent behind a stranded running node", () => {
    const stranded = node("running");
    const dependent = node("pending", [stranded.id]);

    // The stranded node is re-offered; its dependent correctly still waits.
    expect(selectWave([stranded, dependent])).toEqual({
      kind: "ready",
      ids: [stranded.id]
    });
  });
});

describe("selectWave — stuck subsumes every corrupt-DAG shape", () => {
  // These are all unreachable: `createDecomposition` validates the DAG before it
  // persists a row. Each is here to prove the single progress check catches the
  // shape a dedicated detector would have looked for.

  it("catches a two-node cycle", () => {
    const a = node("pending");
    const b = node("pending");
    a.dependsOn = [b.id];
    b.dependsOn = [a.id];

    expect(selectWave([a, b])).toEqual({ kind: "stuck", active: [a.id, b.id] });
  });

  it("catches a three-node cycle", () => {
    const a = node("pending");
    const b = node("pending");
    const c = node("pending");
    a.dependsOn = [c.id];
    b.dependsOn = [a.id];
    c.dependsOn = [b.id];

    expect(selectWave([a, b, c])).toEqual({
      kind: "stuck",
      active: [a.id, b.id, c.id]
    });
  });

  it("catches a self-dependency", () => {
    const a = node("pending");
    a.dependsOn = [a.id];

    expect(selectWave([a])).toEqual({ kind: "stuck", active: [a.id] });
  });

  it("catches a dangling dependency id", () => {
    const orphan = node("pending", [9999]);
    expect(selectWave([orphan])).toEqual({
      kind: "stuck",
      active: [orphan.id]
    });
  });

  it("does not report stuck while any independent branch can still run", () => {
    // A corrupt sub-graph must not stall a branch that can still make progress —
    // the Workflow only fails the Task once nothing at all can run.
    const a = node("pending");
    const b = node("pending");
    a.dependsOn = [b.id];
    b.dependsOn = [a.id];
    const solo = node("pending");

    expect(selectWave([a, b, solo])).toEqual({ kind: "ready", ids: [solo.id] });
  });
});
