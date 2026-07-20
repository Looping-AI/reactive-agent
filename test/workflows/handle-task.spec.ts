import { afterEach, describe, it, expect, vi } from "vitest";
import { importJWK, jwtVerify } from "jose";
import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import type { Task } from "@a2a-js/sdk";
import type { ReactiveAgent } from "@/reactive-agent";
import { runHandleTask, type HandleTaskParams } from "@/workflows/handle-task";
import { TASK_FAILED_TEXT } from "@/a2a/notify";
import type {
  SubtaskNode,
  SubtaskScan,
  SubtaskStatus
} from "@/agent/subtasks/types";
import {
  TEST_AGENT_PRIVATE_JWK,
  GATEWAY_ORIGIN,
  AGENT_ORIGIN
} from "../fixtures";

/**
 * Workflow-level coverage of the five phases. The DO is faked, but the fake owns
 * a real in-memory DAG — it applies the same skip-to-fixpoint rule the parent
 * does — so wave ordering, skip propagation, and fan-out concurrency are actually
 * exercised here rather than scripted. The DO-side behaviour these fakes stand in
 * for is proven for real in `test/reactive-agent/subtasks-rpc.spec.ts`.
 */

const PUSH_URL = `${GATEWAY_ORIGIN}/a2a/notifications`;

// ---------------------------------------------------------------------------
// step fakes
// ---------------------------------------------------------------------------

interface StepFake {
  step: WorkflowStep;
  /** Every `step.do` name, in call order. */
  names: string[];
}

/**
 * A `step` that runs each callback inline and records its name. Tolerates both
 * `do(name, cb)` and `do(name, config, cb)`.
 *
 * `cache` (shared across two runs) makes it a replay fake: a step that already
 * produced a value returns it without re-running the callback, which is what the
 * platform does on replay. Keyed by name **and** occurrence count, matching
 * `WorkflowStepContext.step.count`.
 */
function stepFake(cache?: Map<string, unknown>): StepFake {
  const names: string[] = [];
  const counts = new Map<string, number>();
  const step = {
    do: (async (name: string, a: unknown, b?: unknown) => {
      const cb = (typeof a === "function" ? a : b) as (
        ctx: unknown
      ) => Promise<unknown>;
      names.push(name);
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const key = `${name}#${n}`;
      if (cache?.has(key)) return cache.get(key);
      const out = await cb({});
      cache?.set(key, out);
      return out;
    }) as WorkflowStep["do"]
  } as unknown as WorkflowStep;
  return { step, names };
}

// ---------------------------------------------------------------------------
// agent fake
// ---------------------------------------------------------------------------

/** What `executeSubtaskChunk` should do for a given node. */
type Outcome = "completed" | "failed" | "throw";

interface AgentOptions {
  /** Nodes seeded by decomposition, as `[id, dependsOn]`. Default: one node. */
  dag?: [number, number[]][];
  /** Per-node execution outcome. Default: `completed`. */
  outcomes?: Record<number, Outcome>;
  /** Per-node chunk count before the run terminates. Default: 1 (single chunk). */
  chunks?: Record<number, number>;
  /** Make decomposition report a typed failure. */
  decomposeFails?: boolean;
  /** Make composition report a typed failure. */
  composeFails?: boolean;
  /** Task state `getTask` reports (cancellation). */
  state?: Task["status"]["state"];
  /** Runs when a node starts executing — used to cancel mid-DAG. */
  onExecute?: (id: number, agent: AgentFake) => void;
  /** Runs after composition returns — used to cancel during delivery. */
  onCompose?: (agent: AgentFake) => void;
  /**
   * Make the guarded terminal write refuse while `getTask` still reports the
   * task live — i.e. the cancel landed *after* a probe would have passed but
   * *before* the write. That gap is the whole reason delivery keys on the
   * write's verdict instead of on a separate check.
   */
  saveRefuses?: boolean;
}

interface AgentFake {
  nodes: {
    id: number;
    ordinal: number;
    status: SubtaskStatus;
    dependsOn: number[];
  }[];
  state?: Task["status"]["state"];
  /** Highest number of `executeSubtaskChunk` calls in flight at once. */
  maxConcurrent: number;
  executed: number[];
  failed: { id: number; error: string }[];
  canceledPending: number;
  saved?: Task;
  composeCalls: number;
  decomposeCalls: number;
}

const BLOCKED = new Set<SubtaskStatus>(["failed", "skipped", "canceled"]);

/** Spy on the ReactiveAgent namespace to return a DAG-owning fake stub. */
function mockAgent(opts: AgentOptions = {}): AgentFake {
  const dag = opts.dag ?? [[1, []]];
  const agent: AgentFake = {
    nodes: [],
    state: opts.state,
    maxConcurrent: 0,
    executed: [],
    failed: [],
    canceledPending: 0,
    composeCalls: 0,
    decomposeCalls: 0
  };
  let inFlight = 0;

  const project = (): SubtaskNode[] =>
    agent.nodes.map((n) => ({
      id: n.id,
      ordinal: n.ordinal,
      status: n.status,
      dependsOn: n.dependsOn
    }));

  /** The DO's own cancellation predicate, which every phase RPC now applies. */
  const canceled = () => agent.state === "canceled";

  const stub = {
    getTask: vi.fn(async (): Promise<Task | null> =>
      agent.state ? ({ status: { state: agent.state } } as Task) : null
    ),
    markWorking: vi.fn(async () => (canceled() ? "canceled" : "ok")),

    // Mirrors the guarded write: a canceled row refuses every non-canceled
    // state and reports it, which is what keeps `notify` from firing.
    saveTask: vi.fn(async (task: Task) => {
      if (opts.saveRefuses) return false;
      if (canceled() && task.status.state !== "canceled") return false;
      agent.saved = task;
      return true;
    }),

    decomposeTask: vi.fn(async () => {
      agent.decomposeCalls++;
      if (canceled()) return { status: "canceled" as const };
      if (opts.decomposeFails) {
        return { status: "failed" as const, error: "both models unusable" };
      }
      agent.nodes = dag.map(([id, dependsOn], i) => ({
        id,
        ordinal: i,
        status: "pending" as SubtaskStatus,
        dependsOn
      }));
      return { status: "completed" as const, reply: "On it.", subtasks: [] };
    }),

    // Reports cancellation with the wave, then mirrors the parent's fixpoint
    // rule: a node whose prerequisite did not succeed is skipped, and skipping
    // propagates to its own dependents.
    skipBlockedSubtasks: vi.fn(async (): Promise<SubtaskScan> => {
      if (canceled()) return { canceled: true };
      for (;;) {
        const byId = new Map(agent.nodes.map((n) => [n.id, n]));
        const next = agent.nodes.filter(
          (n) =>
            n.status === "pending" &&
            n.dependsOn.some((d) =>
              BLOCKED.has(byId.get(d)?.status as SubtaskStatus)
            )
        );
        if (next.length === 0) return { canceled: false, nodes: project() };
        for (const n of next) n.status = "skipped";
      }
    }),

    executeSubtaskChunk: vi.fn(async (id: number, chunk: number) => {
      inFlight++;
      agent.maxConcurrent = Math.max(agent.maxConcurrent, inFlight);
      if (chunk === 0) agent.executed.push(id);
      opts.onExecute?.(id, agent);
      // Yield so siblings in the same wave get to start before any finishes —
      // this is what makes `maxConcurrent` meaningful.
      await Promise.resolve();
      inFlight--;

      const outcome = opts.outcomes?.[id] ?? "completed";
      if (outcome === "throw") throw new Error(`transient fault on ${id}`);
      // A node yields `done: false` until it has run its configured chunk count.
      const totalChunks = opts.chunks?.[id] ?? 1;
      if (chunk < totalChunks - 1) {
        return {
          done: false,
          status: "running" as SubtaskStatus,
          progress: []
        };
      }
      const node = agent.nodes.find((n) => n.id === id)!;
      node.status = outcome;
      return { done: true, status: outcome, progress: [] };
    }),

    failSubtask: vi.fn(async (id: number, error: string) => {
      agent.failed.push({ id, error });
      const node = agent.nodes.find((n) => n.id === id);
      if (node) node.status = "failed";
    }),

    cancelPendingSubtasks: vi.fn(async () => {
      const n = agent.nodes.filter((x) => x.status === "pending").length;
      for (const x of agent.nodes) {
        if (x.status === "pending") x.status = "canceled";
      }
      agent.canceledPending = n;
      return n;
    }),

    composeTask: vi.fn(async () => {
      if (canceled()) return { status: "canceled" as const };
      agent.composeCalls++;
      const out = opts.composeFails
        ? { status: "failed" as const, error: "no subtask succeeded" }
        : { status: "completed" as const, reply: "the answer" };
      opts.onCompose?.(agent);
      return out;
    })
  } as unknown as DurableObjectStub<ReactiveAgent>;

  vi.spyOn(env.ReactiveAgent, "get").mockReturnValue(stub);
  return agent;
}

// ---------------------------------------------------------------------------

function params(): HandleTaskParams {
  return {
    taskId: "task-1",
    text: "hi there",
    identity: { key: "custom:1:ada", name: "Ada", kind: "custom" },
    contextId: "ctx-1",
    pushUrl: PUSH_URL,
    pushToken: "tok-xyz",
    jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
  };
}

async function agentPublicKey() {
  const { d: _d, ...pub } = TEST_AGENT_PRIVATE_JWK;
  void _d;
  return importJWK(pub, "EdDSA");
}

/** Capture the callback POST. */
function mockFetch() {
  const captured: { url?: string; init?: RequestInit; calls: number } = {
    calls: 0
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.init = init;
      captured.calls++;
      return new Response("ok", { status: 200 });
    })
  );
  return captured;
}

const bodyOf = (captured: { init?: RequestInit }) =>
  JSON.parse(captured.init?.body as string) as Task;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("HandleTaskWorkflow — the five phases", () => {
  it("runs every phase in order and POSTs a signed completed-Task callback", async () => {
    const agent = mockAgent();
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    // The full durable step sequence — this is what proves the phase order and
    // makes the DAG loop's shape auditable on replay.
    expect(names).toEqual([
      "working",
      "decompose",
      "scan:0",
      "execute:1",
      "scan:1",
      "compose",
      "complete",
      "notify"
    ]);
    expect(agent.saved?.status.state).toBe("completed");

    // POSTed to the gateway webhook with the validation token + signed JWT.
    expect(captured.url).toBe(PUSH_URL);
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("x-a2a-notification-token")).toBe("tok-xyz");

    const bearer =
      headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const { payload } = await jwtVerify(bearer, await agentPublicKey(), {
      audience: PUSH_URL,
      algorithms: ["EdDSA"]
    });
    expect(payload.aud).toBe(PUSH_URL);

    const body = bodyOf(captured);
    expect(body.kind).toBe("task");
    expect(body.id).toBe("task-1");
    expect(body.status.state).toBe("completed");
    expect(body.status.message?.parts?.[0]).toMatchObject({
      kind: "text",
      text: "the answer"
    });
  });

  it("posts exactly the Task it persisted", async () => {
    // The Task is built inside the `complete` step, so `notify` cannot post a
    // re-stamped copy that differs from the stored one.
    const agent = mockAgent();
    const captured = mockFetch();
    await runHandleTask(params(), stepFake().step);

    expect(bodyOf(captured)).toEqual(agent.saved);
  });

  it("runs a multi-chunk node as a sequence of durable chunk steps until done", async () => {
    // A long recipe yields `done: false` and gets another chunk: chunk 0 keeps the
    // historic `execute:<id>` name (single-chunk branches replay byte-identically),
    // later chunks append `:chunk:<n>`, and the loop stops on the terminal chunk.
    const agent = mockAgent({ chunks: { 1: 3 } });
    mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(names.filter((n) => n.startsWith("execute:"))).toEqual([
      "execute:1",
      "execute:1:chunk:1",
      "execute:1:chunk:2"
    ]);
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("threads the push context into decomposition so it can stream the first reply", async () => {
    mockAgent();
    mockFetch();
    await runHandleTask(params(), stepFake().step);

    const stub = env.ReactiveAgent.get({} as DurableObjectId) as unknown as {
      decomposeTask: ReturnType<typeof vi.fn>;
    };
    expect(stub.decomposeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        text: "hi there",
        identity: expect.objectContaining({ key: "custom:1:ada" }),
        push: expect.objectContaining({
          taskId: "task-1",
          contextId: "ctx-1",
          pushUrl: PUSH_URL,
          pushToken: "tok-xyz"
        })
      })
    );
  });
});

describe("HandleTaskWorkflow — DAG execution", () => {
  it("runs independent branches concurrently in one wave", async () => {
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, []],
        [3, []]
      ]
    });
    mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.maxConcurrent).toBe(3);
    expect(names.filter((n) => n.startsWith("execute:"))).toEqual([
      "execute:1",
      "execute:2",
      "execute:3"
    ]);
    // One wave of work, then a scan that observes `done`.
    expect(names.filter((n) => n.startsWith("scan:"))).toEqual([
      "scan:0",
      "scan:1"
    ]);
  });

  it("runs a dependency chain one wave at a time, in order", async () => {
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, [1]],
        [3, [2]]
      ]
    });
    mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.executed).toEqual([1, 2, 3]);
    expect(agent.maxConcurrent).toBe(1);
    expect(names).toEqual([
      "working",
      "decompose",
      "scan:0",
      "execute:1",
      "scan:1",
      "execute:2",
      "scan:2",
      "execute:3",
      "scan:3",
      "compose",
      "complete",
      "notify"
    ]);
  });

  it("releases a fan-in node only after both prerequisites complete", async () => {
    // diamond: 1 → {2,3} → 4
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, [1]],
        [3, [1]],
        [4, [2, 3]]
      ]
    });
    mockFetch();
    await runHandleTask(params(), stepFake().step);

    expect(agent.executed).toEqual([1, 2, 3, 4]);
    expect(agent.maxConcurrent).toBe(2); // the {2,3} wave
  });

  it("skips a failed branch's descendants while independent branches finish", async () => {
    // 1 → 2 → 3, plus an independent 4. Node 1 fails.
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, [1]],
        [3, [2]],
        [4, []]
      ],
      outcomes: { 1: "failed" }
    });
    mockFetch();
    await runHandleTask(params(), stepFake().step);

    // 2 and 3 never ran; 4 did — one branch's failure never stops another's.
    expect(agent.executed.sort()).toEqual([1, 4]);
    const status = (id: number) => agent.nodes.find((n) => n.id === id)?.status;
    expect(status(2)).toBe("skipped");
    expect(status(3)).toBe("skipped");
    expect(status(4)).toBe("completed");

    // Composition still runs and the Task completes: partial success is a result.
    expect(agent.composeCalls).toBe(1);
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("fails only the branch whose step exhausted its retries, then composes", async () => {
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, []]
      ],
      outcomes: { 1: "throw" }
    });
    mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    // The throwing branch is forced terminal so it cannot stall the DAG…
    expect(names).toContain("fail:1");
    expect(agent.failed).toEqual([
      { id: 1, error: expect.stringContaining("exhausted retries") }
    ]);
    // …and its sibling's durable work still reaches composition.
    expect(agent.executed).toContain(2);
    expect(agent.composeCalls).toBe(1);
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("delivers a failed Task when the DAG cannot progress", async () => {
    // A cycle — unreachable in production (`createDecomposition` rejects it), so
    // this proves the safety net routes to failed delivery instead of spinning.
    const agent = mockAgent({
      dag: [
        [1, [2]],
        [2, [1]]
      ]
    });
    const captured = mockFetch();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runHandleTask(params(), stepFake().step);

    expect(agent.executed).toEqual([]);
    expect(agent.composeCalls).toBe(0);
    expect(bodyOf(captured).status.state).toBe("failed");
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("HandleTaskWorkflow — failure delivery", () => {
  it("delivers a failed Task with user-safe text when decomposition fails", async () => {
    const agent = mockAgent({ decomposeFails: true });
    const captured = mockFetch();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    // No DAG, no composition — straight to failed delivery.
    expect(names).toEqual(["working", "decompose", "complete", "notify"]);
    expect(agent.composeCalls).toBe(0);

    const body = bodyOf(captured);
    expect(body.status.state).toBe("failed");
    expect(body.status.message?.parts?.[0]).toMatchObject({
      text: TASK_FAILED_TEXT
    });

    // The diagnostic is logged, never sent to the user.
    expect(errorLog).toHaveBeenCalledWith(
      "[handle-task] decomposition failed",
      expect.objectContaining({ error: "both models unusable" })
    );
    expect(JSON.stringify(body)).not.toContain("both models unusable");
  });

  it("delivers a failed Task when no branch succeeded", async () => {
    const agent = mockAgent({ outcomes: { 1: "failed" }, composeFails: true });
    const captured = mockFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runHandleTask(params(), stepFake().step);

    expect(agent.composeCalls).toBe(1);
    expect(bodyOf(captured).status.state).toBe("failed");
    expect(JSON.stringify(bodyOf(captured))).not.toContain("no subtask");
  });
});

describe("HandleTaskWorkflow — cancellation", () => {
  it("stops before decomposition when already canceled", async () => {
    // `markWorking` would otherwise resurrect the task to `working`.
    const agent = mockAgent({ state: "canceled" });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(names).toEqual(["working"]);
    expect(agent.decomposeCalls).toBe(0);
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });

  it("stops scheduling and cancels pending subtasks when canceled mid-DAG", async () => {
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, [1]],
        [3, [2]]
      ],
      onExecute: (id, a) => {
        if (id === 1) a.state = "canceled";
      }
    });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    // Wave 0 ran; the next scan saw the cancellation and stopped.
    expect(agent.executed).toEqual([1]);
    expect(agent.canceledPending).toBe(2);
    expect(names).toContain("cancel:1");
    expect(agent.composeCalls).toBe(0);
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });

  // The regression test for the window that existed before: the task looks live
  // when delivery starts, so any pre-flight probe passes, and the cancel lands
  // before the write. Ignoring the write's verdict — as a probe-then-save does —
  // posts a `completed` callback for work the caller already gave up on.
  it("sends no terminal callback when the guarded write refuses", async () => {
    const agent = mockAgent({ saveRefuses: true });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.composeCalls).toBe(1);
    expect(names).toContain("complete");
    expect(names).not.toContain("notify");
    expect(captured.calls).toBe(0);
  });

  it("sends no terminal callback when canceled during delivery", async () => {
    // Composition produced a real reply, and only then did the caller cancel —
    // so the workflow reaches `complete` with a Task it fully intends to send.
    const agent = mockAgent({
      onCompose: (a) => {
        a.state = "canceled";
      }
    });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.composeCalls).toBe(1);
    expect(names).toContain("complete");
    expect(names).not.toContain("notify");
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });

  it("does not compose or deliver when canceled after the DAG finished", async () => {
    const agent = mockAgent({
      onExecute: (_id, a) => {
        a.state = "canceled";
      }
    });
    const captured = mockFetch();

    await runHandleTask(params(), stepFake().step);

    expect(agent.composeCalls).toBe(0);
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });
});

describe("HandleTaskWorkflow — replay", () => {
  it("repeats no inference, no persistence, and no delivery on a replayed run", async () => {
    const agent = mockAgent({
      dag: [
        [1, []],
        [2, [1]]
      ]
    });
    const captured = mockFetch();
    const cache = new Map<string, unknown>();

    await runHandleTask(params(), stepFake(cache).step);

    expect(agent.decomposeCalls).toBe(1);
    expect(agent.composeCalls).toBe(1);
    expect(agent.executed).toEqual([1, 2]);
    expect(captured.calls).toBe(1);

    // Replay the whole instance against the same durable step cache.
    const replay = stepFake(cache);
    await runHandleTask(params(), replay.step);

    // Every step replayed from cache: no second decomposition, no second
    // execution, no second composition, no duplicate callback.
    expect(agent.decomposeCalls).toBe(1);
    expect(agent.composeCalls).toBe(1);
    expect(agent.executed).toEqual([1, 2]);
    expect(captured.calls).toBe(1);
    // …and the replayed run still walked the identical step sequence.
    expect(replay.names).toEqual([
      "working",
      "decompose",
      "scan:0",
      "execute:1",
      "scan:1",
      "execute:2",
      "scan:2",
      "compose",
      "complete",
      "notify"
    ]);
  });
});
