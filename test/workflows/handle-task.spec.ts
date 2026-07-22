import { afterEach, describe, it, expect, vi } from "vitest";
import { importJWK, jwtVerify } from "jose";
import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import type { Task } from "@a2a-js/sdk";
import type { ReactiveAgent } from "@/reactive-agent";
import { runHandleTask, type HandleTaskParams } from "@/workflows/handle-task";
import { TASK_FAILED_TEXT } from "@/a2a/notify";
import { MAX_CHUNKS_PER_BRANCH, MAX_TURN_ROUNDS } from "@/config";
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
 * Workflow-level coverage of the round loop. The DO is faked, but the fake owns
 * a real in-memory DAG — it applies the same skip-to-fixpoint rule the parent
 * does, and it honors `allowControl` the way a real round does (a round handed no
 * control tools cannot delegate) — so wave ordering, skip propagation, fan-out
 * concurrency, and the round budget are actually exercised here rather than
 * scripted. The DO-side behaviour these fakes stand in for is proven for real in
 * `test/reactive-agent/subtasks-rpc.spec.ts`.
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

/**
 * One scripted round: it delegates a DAG (`[id, dependsOn][]`), answers the user,
 * or reports a typed failure. A round scripted to delegate but handed
 * `allowControl: false` answers instead — the real model has no tool to call.
 */
type Round =
  { dag: [number, number[]][] } | { reply: string } | { fails: string };

/** Delegate then answer — the shape a normal task takes. */
const DEFAULT_ROUNDS: Round[] = [{ dag: [[1, []]] }, { reply: "the answer" }];

interface AgentOptions {
  /** The rounds to script, in order. Default: delegate one node, then answer. */
  rounds?: Round[];
  /** Per-node execution outcome. Default: `completed`. */
  outcomes?: Record<number, Outcome>;
  /** Per-node chunk count before the run terminates. Default: 1 (single chunk). */
  chunks?: Record<number, number>;
  /** Task state `getTask` reports (cancellation). */
  state?: Task["status"]["state"];
  /** Runs when a node starts executing — used to cancel mid-DAG. */
  onExecute?: (id: number, agent: AgentFake) => void;
  /** Runs after a round returns — used to cancel during delivery. */
  onTurn?: (agent: AgentFake) => void;
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
    round: number;
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
  /** Set once the post-delivery child sweep ran. */
  swept?: boolean;
  /** One entry per round that actually ran an inference, in order. */
  turns: { round: number; allowControl: boolean; decision: string }[];
}

const BLOCKED = new Set<SubtaskStatus>(["failed", "skipped", "canceled"]);

/** Spy on the ReactiveAgent namespace to return a DAG-owning fake stub. */
function mockAgent(opts: AgentOptions = {}): AgentFake {
  const rounds = opts.rounds ?? DEFAULT_ROUNDS;
  const agent: AgentFake = {
    nodes: [],
    state: opts.state,
    maxConcurrent: 0,
    executed: [],
    failed: [],
    canceledPending: 0,
    turns: []
  };
  let inFlight = 0;

  const project = (round: number): SubtaskNode[] =>
    agent.nodes
      .filter((n) => n.round === round)
      .map((n) => ({
        id: n.id,
        ordinal: n.ordinal,
        status: n.status,
        dependsOn: n.dependsOn
      }));

  /** The DO's own cancellation predicate, which every round-loop RPC applies. */
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

    runTaskTurn: vi.fn(
      async (input: { round: number; allowControl: boolean }) => {
        if (canceled()) return { status: "canceled" as const };
        const script = rounds[input.round] ?? { reply: "the answer" };

        // A round with no control tools cannot delegate, whatever it intended.
        const delegating = "dag" in script && input.allowControl;
        const decision =
          "fails" in script ? "failed" : delegating ? "delegated" : "replied";
        agent.turns.push({
          round: input.round,
          allowControl: input.allowControl,
          decision
        });

        if ("fails" in script) {
          return { status: "failed" as const, error: script.fails };
        }
        if (!delegating) {
          const reply = "reply" in script ? script.reply : "forced answer";
          const out = { status: "replied" as const, reply };
          opts.onTurn?.(agent);
          return out;
        }

        const base = agent.nodes.length;
        for (const [i, [id, dependsOn]] of script.dag.entries()) {
          agent.nodes.push({
            id,
            round: input.round,
            ordinal: base + i,
            status: "pending",
            dependsOn
          });
        }
        const out = {
          status: "delegated" as const,
          reply: "On it.",
          subtasks: []
        };
        opts.onTurn?.(agent);
        return out;
      }
    ),

    // Reports cancellation with the wave, then mirrors the parent's fixpoint
    // rule: a node whose prerequisite did not succeed is skipped, and skipping
    // propagates to its own dependents. Scoped to the round, as the DO is.
    skipBlockedSubtasks: vi.fn(
      async (_taskId: string, round: number): Promise<SubtaskScan> => {
        if (canceled()) return { canceled: true };
        for (;;) {
          const byId = new Map(agent.nodes.map((n) => [n.id, n]));
          const next = agent.nodes.filter(
            (n) =>
              n.round === round &&
              n.status === "pending" &&
              n.dependsOn.some((d) =>
                BLOCKED.has(byId.get(d)?.status as SubtaskStatus)
              )
          );
          if (next.length === 0) {
            return { canceled: false, nodes: project(round) };
          }
          for (const n of next) n.status = "skipped";
        }
      }
    ),

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

    // Post-delivery child sweep. Records that it ran so the ordering assertion
    // can pin it between `complete` and `notify`.
    sweepTaskChildren: vi.fn(async () => {
      agent.swept = true;
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

describe("HandleTaskWorkflow — the round loop", () => {
  it("runs delegate → execute → answer and POSTs a signed completed-Task callback", async () => {
    const agent = mockAgent();
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    // The full durable step sequence — this is what proves the loop's shape and
    // makes it auditable on replay. Every name inside the loop carries its round.
    expect(names).toEqual([
      "working",
      "turn:0",
      "scan:0:0",
      "execute:1",
      "scan:0:1",
      "turn:1",
      "complete",
      "sweep",
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

  it("delivers a round-0 answer with no subtasks at all", async () => {
    // The emancipated path: a request the main agent is best placed to answer
    // never reaches a subagent, and costs exactly one inference.
    const agent = mockAgent({ rounds: [{ reply: "You said aisle seats." }] });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(names).toEqual(["working", "turn:0", "complete", "sweep", "notify"]);
    expect(agent.executed).toEqual([]);
    expect(agent.turns).toEqual([
      { round: 0, allowControl: true, decision: "replied" }
    ]);
    expect(bodyOf(captured).status.message?.parts?.[0]).toMatchObject({
      text: "You said aisle seats."
    });
  });

  it("runs a second round of delegation before answering", async () => {
    const agent = mockAgent({
      rounds: [{ dag: [[1, []]] }, { dag: [[2, []]] }, { reply: "the answer" }]
    });
    mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.executed).toEqual([1, 2]);
    expect(names).toEqual([
      "working",
      "turn:0",
      "scan:0:0",
      "execute:1",
      "scan:0:1",
      "turn:1",
      "scan:1:0",
      "execute:2",
      "scan:1:1",
      "turn:2",
      "complete",
      "sweep",
      "notify"
    ]);
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("scopes each round's wave scan to that round's own DAG", async () => {
    // Round 1 must not re-scan round 0's terminal rows — the scan feeds a
    // scheduler that would call a completed sibling "active".
    const agent = mockAgent({
      rounds: [{ dag: [[1, []]] }, { dag: [[2, []]] }, { reply: "done" }]
    });
    mockFetch();
    await runHandleTask(params(), stepFake().step);

    const stub = env.ReactiveAgent.get({} as DurableObjectId) as unknown as {
      skipBlockedSubtasks: ReturnType<typeof vi.fn>;
    };
    expect(stub.skipBlockedSubtasks.mock.calls.map((c) => c[1])).toEqual([
      0, 0, 1, 1
    ]);
    expect(agent.nodes.map((n) => n.round)).toEqual([0, 1]);
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

  it("threads the push context into every round so it can stream progress", async () => {
    mockAgent();
    mockFetch();
    await runHandleTask(params(), stepFake().step);

    const stub = env.ReactiveAgent.get({} as DurableObjectId) as unknown as {
      runTaskTurn: ReturnType<typeof vi.fn>;
    };
    expect(stub.runTaskTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        text: "hi there",
        round: 0,
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

describe("HandleTaskWorkflow — round budget", () => {
  it("hands the last round no control tools, so it must answer", async () => {
    // Every round asks to delegate; only the budget stops it.
    const agent = mockAgent({
      rounds: Array.from({ length: MAX_TURN_ROUNDS }, (_, i) => ({
        dag: [[i + 1, []]] as [number, number[]][]
      }))
    });
    mockFetch();

    await runHandleTask(params(), stepFake().step);

    expect(agent.turns).toHaveLength(MAX_TURN_ROUNDS);
    expect(agent.turns.map((t) => t.allowControl)).toEqual([
      ...Array(MAX_TURN_ROUNDS - 1).fill(true),
      false
    ]);
    // The last round answered rather than delegating a ninth DAG.
    expect(agent.turns.at(-1)?.decision).toBe("replied");
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("stops offering delegation once the task has spent its execution budget", async () => {
    // Two branches at the per-branch cap exceed MAX_CHUNKS_PER_TASK between them,
    // so the third round is handed no control tools even though rounds remain.
    const agent = mockAgent({
      rounds: [
        { dag: [[1, []]] },
        { dag: [[2, []]] },
        { dag: [[3, []]] },
        { reply: "unreached" }
      ],
      chunks: { 1: MAX_CHUNKS_PER_BRANCH, 2: MAX_CHUNKS_PER_BRANCH }
    });
    mockFetch();

    await runHandleTask(params(), stepFake().step);

    expect(agent.turns.map((t) => t.allowControl)).toEqual([true, true, false]);
    // Round 2 answered from what it had; node 3 never ran.
    expect(agent.executed).toEqual([1, 2]);
    expect(agent.saved?.status.state).toBe("completed");
  });
});

describe("HandleTaskWorkflow — DAG execution", () => {
  it("runs independent branches concurrently in one wave", async () => {
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, []],
            [2, []],
            [3, []]
          ]
        },
        { reply: "the answer" }
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
      "scan:0:0",
      "scan:0:1"
    ]);
  });

  it("runs a dependency chain one wave at a time, in order", async () => {
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, []],
            [2, [1]],
            [3, [2]]
          ]
        },
        { reply: "the answer" }
      ]
    });
    mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.executed).toEqual([1, 2, 3]);
    expect(agent.maxConcurrent).toBe(1);
    expect(names).toEqual([
      "working",
      "turn:0",
      "scan:0:0",
      "execute:1",
      "scan:0:1",
      "execute:2",
      "scan:0:2",
      "execute:3",
      "scan:0:3",
      "turn:1",
      "complete",
      "sweep",
      "notify"
    ]);
  });

  it("releases a fan-in node only after both prerequisites complete", async () => {
    // diamond: 1 → {2,3} → 4
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, []],
            [2, [1]],
            [3, [1]],
            [4, [2, 3]]
          ]
        },
        { reply: "the answer" }
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
      rounds: [
        {
          dag: [
            [1, []],
            [2, [1]],
            [3, [2]],
            [4, []]
          ]
        },
        { reply: "the answer" }
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

    // The next round still runs and the Task completes: partial success is a
    // result, and the model discloses the gap.
    expect(agent.turns).toHaveLength(2);
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("fails only the branch whose step exhausted its retries, then answers", async () => {
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, []],
            [2, []]
          ]
        },
        { reply: "the answer" }
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
    // …and its sibling's durable work still reaches the next round.
    expect(agent.executed).toContain(2);
    expect(agent.turns).toHaveLength(2);
    expect(agent.saved?.status.state).toBe("completed");
  });

  it("delivers a failed Task when the DAG cannot progress", async () => {
    // A cycle — unreachable in production (`createDecomposition` rejects it), so
    // this proves the safety net routes to failed delivery instead of spinning.
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, [2]],
            [2, [1]]
          ]
        },
        { reply: "unreached" }
      ]
    });
    const captured = mockFetch();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runHandleTask(params(), stepFake().step);

    expect(agent.executed).toEqual([]);
    expect(agent.turns).toHaveLength(1);
    expect(bodyOf(captured).status.state).toBe("failed");
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("HandleTaskWorkflow — failure delivery", () => {
  it("delivers a failed Task with user-safe text when a round fails", async () => {
    const agent = mockAgent({ rounds: [{ fails: "both models unusable" }] });
    const captured = mockFetch();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    // No DAG, no second round — straight to failed delivery.
    expect(names).toEqual(["working", "turn:0", "complete", "sweep", "notify"]);
    expect(agent.turns).toHaveLength(1);

    const body = bodyOf(captured);
    expect(body.status.state).toBe("failed");
    expect(body.status.message?.parts?.[0]).toMatchObject({
      text: TASK_FAILED_TEXT
    });

    // The diagnostic is logged, never sent to the user.
    expect(errorLog).toHaveBeenCalledWith(
      "[handle-task] round failed",
      expect.objectContaining({ error: "both models unusable" })
    );
    expect(JSON.stringify(body)).not.toContain("both models unusable");
  });

  it("delivers a failed Task when a later round has nothing to answer with", async () => {
    const agent = mockAgent({
      rounds: [{ dag: [[1, []]] }, { fails: "no subtask succeeded" }],
      outcomes: { 1: "failed" }
    });
    const captured = mockFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runHandleTask(params(), stepFake().step);

    expect(agent.turns).toHaveLength(2);
    expect(bodyOf(captured).status.state).toBe("failed");
    expect(JSON.stringify(bodyOf(captured))).not.toContain("no subtask");
  });
});

describe("HandleTaskWorkflow — cancellation", () => {
  it("stops before the first round when already canceled", async () => {
    // `markWorking` would otherwise resurrect the task to `working`.
    const agent = mockAgent({ state: "canceled" });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(names).toEqual(["working"]);
    expect(agent.turns).toEqual([]);
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });

  it("stops scheduling and cancels pending subtasks when canceled mid-DAG", async () => {
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, []],
            [2, [1]],
            [3, [2]]
          ]
        },
        { reply: "unreached" }
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
    expect(names).toContain("cancel:0:1");
    expect(agent.turns).toHaveLength(1);
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

    expect(agent.turns).toHaveLength(2);
    expect(names).toContain("complete");
    expect(names).not.toContain("notify");
    expect(captured.calls).toBe(0);
  });

  it("sends no terminal callback when canceled during delivery", async () => {
    // The final round produced a real reply, and only then did the caller cancel
    // — so the workflow reaches `complete` with a Task it fully intends to send.
    const agent = mockAgent({
      onTurn: (a) => {
        if (a.turns.at(-1)?.decision === "replied") a.state = "canceled";
      }
    });
    const captured = mockFetch();
    const { step, names } = stepFake();

    await runHandleTask(params(), step);

    expect(agent.turns).toHaveLength(2);
    expect(names).toContain("complete");
    expect(names).not.toContain("notify");
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });

  it("does not start the next round or deliver when canceled after the DAG finished", async () => {
    const agent = mockAgent({
      onExecute: (_id, a) => {
        a.state = "canceled";
      }
    });
    const captured = mockFetch();

    await runHandleTask(params(), stepFake().step);

    expect(agent.turns).toHaveLength(1);
    expect(agent.saved).toBeUndefined();
    expect(captured.calls).toBe(0);
  });
});

describe("HandleTaskWorkflow — replay", () => {
  it("repeats no inference, no persistence, and no delivery on a replayed run", async () => {
    const agent = mockAgent({
      rounds: [
        {
          dag: [
            [1, []],
            [2, [1]]
          ]
        },
        { reply: "the answer" }
      ]
    });
    const captured = mockFetch();
    const cache = new Map<string, unknown>();

    await runHandleTask(params(), stepFake(cache).step);

    expect(agent.turns).toHaveLength(2);
    expect(agent.executed).toEqual([1, 2]);
    expect(captured.calls).toBe(1);

    // Replay the whole instance against the same durable step cache.
    const replay = stepFake(cache);
    await runHandleTask(params(), replay.step);

    // Every step replayed from cache: no second inference, no second execution,
    // no duplicate callback.
    expect(agent.turns).toHaveLength(2);
    expect(agent.executed).toEqual([1, 2]);
    expect(captured.calls).toBe(1);
    // …and the replayed run still walked the identical step sequence.
    expect(replay.names).toEqual([
      "working",
      "turn:0",
      "scan:0:0",
      "execute:1",
      "scan:0:1",
      "execute:2",
      "scan:0:2",
      "turn:1",
      "complete",
      "sweep",
      "notify"
    ]);
  });
});
