import { WorkflowEntrypoint, env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { GatewayIdentity } from "@/a2a/verify";
import { parsePrivateJwk } from "@/a2a/card";
import {
  TASK_FAILED_TEXT,
  buildCompletedTask,
  buildFailedTask,
  postNotification,
  signCallbackJwt
} from "@/a2a/notify";
import { getAgent, type TurnPushContext } from "@/reactive-agent";
import { selectWave } from "@/agent/subtasks/scheduler";
import type { SubtaskId } from "@/agent/subtasks/types";
import {
  MAX_SUBTASKS,
  MAX_CHUNKS_PER_BRANCH,
  MAX_CHUNKS_PER_TASK,
  MAX_TURN_ROUNDS
} from "@/config";

/**
 * The async task controller. The gateway no longer waits for a synchronous reply:
 * the Worker accepts a turn (returns a `submitted` Task) and hands the actual work
 * to this durable Workflow, which orchestrates it end to end and delivers the
 * reply to the gateway's push-notification webhook.
 *
 * The shape is a **round loop**, not a fixed sequence of phases:
 *
 * 0. **Pre-work** — resolve the caller's agent, mark the Task working.
 * 1. **Round** — one main-agent inference that either answers the user (the Task
 *    is done) or delegates 1..8 durable Subtasks plus the acknowledgment the user
 *    sees while they run.
 * 2. **Execute** — a delegating round's Subtask DAG runs in waves, every
 *    dependency-ready node concurrently, each in an isolated managed subagent.
 *    Then the loop returns to 1, where the model sees the results and decides
 *    again — answer, or delegate once more.
 * 3. **Deliver** — persist the terminal Task, then POST a signed callback.
 *
 * The main agent is never forced either way. The last round of the budget is
 * offered no control tools at all, so it has to answer; every earlier round
 * chooses. That is the whole reason this file is a loop.
 *
 * Why a Workflow (not a DO alarm / `waitUntil`): `step.do(...)` gives durable,
 * independently-retried steps that survive isolate eviction, and a future
 * `escalate` decision (ask the human, then continue) slots in cleanly as another
 * branch of the loop built on `step.waitForEvent(...)`.
 *
 * A Workflow is a separate entrypoint and cannot touch the agent DO's SQLite
 * directly, so: the task inputs travel as the workflow **payload**, and the agent
 * runtime + task state are reached only through **native DO RPC** — see
 * {@link file://../reactive-agent/index.ts}.
 *
 * Idempotency: the instance id is derived from the gateway's `messageId`
 * (deterministic across dispatch retries), so a re-dispatch never starts a second
 * run. Within a run, every step is re-runnable: the Subtask rows and the Session
 * are the source of truth, and each round recovers from them rather than
 * re-inferring.
 */
export interface HandleTaskParams {
  /** The accepted task id (echoed back to the gateway on the callback). */
  taskId: string;
  /** The user turn text to answer. */
  text: string;
  /** The verified calling gateway-agent identity (keys the DO + the Session). */
  identity: GatewayIdentity;
  /** A2A context id, echoed on the completed Task. */
  contextId: string;
  /** Gateway push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gateway set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

/** The caller's agent DO stub — every phase runs through it. */
type AgentStub = ReturnType<typeof getAgent>;

export class HandleTaskWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runHandleTask(event.payload, step);
  }
}

/**
 * The orchestration itself, split from the `WorkflowEntrypoint` wiring so it can
 * be driven with a fake `step` in tests (workerd forbids constructing a
 * `WorkflowEntrypoint` outside the runtime). Reads env via the module-level
 * `cloudflare:workers` import rather than a parameter.
 *
 * Every `step.do` return here is a small projection — a status, an id, a reply.
 * Never a Subtask row: a step return is capped at 1 MiB and a Subtask carries
 * verbatim history snapshots, so the rows stay in the DO and the Workflow carries
 * references to them (the Core Invariant — "Workflow state is not their source of
 * truth").
 *
 * **Step names are durable cache keys.** Everything inside the round loop carries
 * its round for that reason: `turn:<round>`, `scan:<round>:<wave>`,
 * `cancel:<round>:<wave>`. Renaming one silently re-runs its effect on replay.
 */
export async function runHandleTask(
  p: HandleTaskParams,
  step: WorkflowStep
): Promise<void> {
  // Pre-work. Routing is pure, so it needs no step of its own.
  const stub = getAgent(p.identity);
  const push: TurnPushContext = {
    taskId: p.taskId,
    contextId: p.contextId,
    pushUrl: p.pushUrl,
    pushToken: p.pushToken,
    jku: p.jku
  };

  const started = await step.do(
    "working",
    async () => (await stub.markWorking(p.taskId)) === "ok"
  );
  if (!started) return;

  // Durable chunk steps spent so far, across every round. Summed from cached step
  // returns, so a replay reconstructs the identical number and the `allowControl`
  // input below stays deterministic.
  let chunksUsed = 0;

  for (let round = 0; round < MAX_TURN_ROUNDS; round++) {
    // The main agent decides. `runTaskTurn` persists whatever the round produced
    // — a final reply, or the Subtask rows plus the acknowledgment it already
    // pushed — so this step returns only the verdict. A typed `failed` is a real
    // outcome (both models produced unusable output, with no durable work to fall
    // back on) and routes to failed delivery; a transient fault throws and the
    // step retries, recovering from the durable rows with no second inference.
    //
    // A round may delegate only while there is budget left for another round *and*
    // for the execution it would start. Denying it is not a failure mode: the
    // round is simply handed no control tools and answers from what it has.
    const allowControl =
      round < MAX_TURN_ROUNDS - 1 && chunksUsed < MAX_CHUNKS_PER_TASK;

    const turn = await step.do(`turn:${round}`, async () => {
      // Projected to a plain object: an RPC return carries a `Disposable` brand a
      // step result cannot serialize.
      const result = await stub.runTaskTurn({
        taskId: p.taskId,
        text: p.text,
        identity: p.identity,
        round,
        allowControl,
        push
      });
      if (result.status === "replied")
        return { status: result.status, reply: result.reply };
      if (result.status === "failed")
        return { status: result.status, error: result.error };
      return { status: result.status };
    });

    if (turn.status === "canceled") return;
    if (turn.status === "failed") {
      console.error("[handle-task] round failed", {
        taskId: p.taskId,
        round,
        error: turn.error
      });
      await deliver(p, step, stub, null);
      return;
    }
    if (turn.status === "replied") {
      await deliver(p, step, stub, turn.reply);
      return;
    }

    // Delegated: run this round's DAG, then loop and let the model decide again.
    const executed = await executeDag(p, step, stub, round, push);
    if (executed.outcome === "canceled") return;
    chunksUsed += executed.chunks;
    if (executed.outcome === "stuck") {
      await deliver(p, step, stub, null);
      return;
    }
  }

  // Unreachable: the last round is offered no control tools, so it either answers
  // or fails, and both return above. Reaching here means a round delegated when it
  // was told it could not.
  console.error("[handle-task] round budget exhausted without a reply", {
    taskId: p.taskId
  });
  await deliver(p, step, stub, null);
}

/**
 * How one round's DAG ended, plus the durable chunk steps it spent (which the
 * round loop meters against `MAX_CHUNKS_PER_TASK`). `stuck` is an invariant
 * violation — see {@link selectWave}.
 */
interface DagResult {
  outcome: "done" | "canceled" | "stuck";
  chunks: number;
}

/**
 * Drive one round's Subtask DAG to termination, one wave at a time.
 *
 * Bounded by `MAX_SUBTASKS + 1` iterations rather than looping until `done`: a
 * wave that reports `ready` always retires at least one active node, so 8
 * Subtasks need at most 8 waves of work plus one final scan to observe `done`.
 * Exhausting the budget means the DAG stopped making progress, which is the same
 * corruption `stuck` names.
 *
 * Every step name carries the round, because step names are durable cache keys:
 * two rounds of the same Task reusing `scan:0` would replay the first round's
 * cached answer into the second.
 */
async function executeDag(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  round: number,
  push: TurnPushContext
): Promise<DagResult> {
  let chunks = 0;
  for (let wave = 0; wave <= MAX_SUBTASKS; wave++) {
    // One durable step per wave: `skipBlockedSubtasks` reports cancellation,
    // propagates skips past any branch that just failed, and returns the
    // refreshed DAG projection — one round trip, one consistent answer.
    const scan = await step.do(`scan:${round}:${wave}`, async () => {
      const result = await stub.skipBlockedSubtasks(p.taskId, round);
      return result.canceled
        ? { canceled: true as const, nodes: [] }
        : { canceled: false as const, nodes: result.nodes };
    });

    if (scan.canceled) {
      await step.do(`cancel:${round}:${wave}`, async () => {
        await stub.cancelPendingSubtasks(p.taskId);
      });
      return { outcome: "canceled", chunks };
    }

    const decision = selectWave(scan.nodes);
    if (decision.kind === "done") return { outcome: "done", chunks };
    if (decision.kind === "stuck") {
      console.error("[handle-task] subtask DAG made no progress", {
        taskId: p.taskId,
        round,
        wave,
        active: decision.active
      });
      return { outcome: "stuck", chunks };
    }

    // Every dependency-ready node runs concurrently — the 8-Subtask maximum is
    // the only fan-out bound. `runBranch` never rejects, so a single branch
    // cannot fast-fail `Promise.all` and strand its siblings' durable results.
    const spent = await Promise.all(
      decision.ids.map((id) => runBranch(p, step, stub, id, push))
    );
    for (const n of spent) chunks += n;
  }

  console.error("[handle-task] subtask DAG exceeded its wave budget", {
    taskId: p.taskId,
    round
  });
  return { outcome: "stuck", chunks };
}

/**
 * Run one Subtask to termination as a sequence of durable **chunk** steps, and
 * make sure the row ends terminal either way.
 *
 * `executeSubtaskChunk(id, chunk)` advances one chunk: a single-chunk recipe is
 * `done` on chunk 0 (step `execute:<id>`, byte-identical to the pre-resumable
 * pipeline); a long recipe yields `done: false` and the loop runs the next chunk
 * (`execute:<id>:chunk:<n>`) until it terminates. Each chunk is its own retryable
 * step, and the child resumes from its checkpoint — so no step approaches the
 * platform timeout.
 *
 * It resolves a deterministic branch failure into a `failed` row itself and
 * throws only on a transient fault (retry me) or a lifecycle bug. So a throw that
 * survives every retry — or a run that never terminates within the chunk budget —
 * means nobody is left to resolve this row: fail *the branch* and let the next
 * round disclose the gap, rather than discarding the durable work its siblings
 * finished.
 *
 * Returns the number of chunk steps it spent, which the round loop meters against
 * the whole-Task budget. Step ids are unique across rounds (SQLite assigns them),
 * so these names need no round prefix.
 */
async function runBranch(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  id: SubtaskId,
  push: TurnPushContext
): Promise<number> {
  let spent = 0;
  try {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_BRANCH; chunk++) {
      spent = chunk + 1;
      // Chunk 0 keeps the historic `execute:<id>` step name so single-chunk
      // branches replay byte-identically; later chunks append `:chunk:<n>`.
      const stepName =
        chunk === 0 ? `execute:${id}` : `execute:${id}:chunk:${chunk}`;
      const done = await step.do(stepName, async () => {
        // The DO posts any progress itself; the step returns only the verdict.
        const outcome = await stub.executeSubtaskChunk(id, chunk, push);
        return outcome.done;
      });
      if (done) return spent;
    }
    // The run never terminated within its chunk budget — treat as stuck.
    console.error("[handle-task] subtask exceeded its chunk budget", {
      taskId: p.taskId,
      subtaskId: id
    });
    await step.do(`fail:${id}`, async () => {
      await stub.failSubtask(
        id,
        `execution exceeded ${MAX_CHUNKS_PER_BRANCH} chunks`
      );
    });
    return spent;
  } catch (err) {
    console.error("[handle-task] subtask execution exhausted retries", {
      taskId: p.taskId,
      subtaskId: id,
      err: String(err)
    });
    await step.do(`fail:${id}`, async () => {
      await stub.failSubtask(id, `execution exhausted retries: ${String(err)}`);
    });
    return spent;
  }
}

/**
 * Phase 4: persist the terminal Task, then notify the gateway. A null `reply`
 * delivers a `failed` Task with user-safe text; the diagnostic is already logged.
 *
 * The Task is built **inside** the step and returned, so `notify` posts exactly
 * what was persisted: building it in the body would re-stamp `new Date()` on
 * every replay and post a Task that differs from the stored one.
 *
 * **The guarded write is the cancellation check.** `saveTask` refuses to write a
 * terminal state over a `canceled` row and says so, and it does that read and
 * write in one synchronous pass inside the DO. Probing first and saving second
 * would leave a window — between the two calls, and again between this step and
 * `notify` — in which a `tasks/cancel` lands and the gateway still receives a
 * `completed` callback. Keying the notify on "did the write apply" closes it.
 */
async function deliver(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  reply: string | null
): Promise<void> {
  const task = await step.do("complete", async () => {
    const terminal =
      reply !== null
        ? buildCompletedTask(p.taskId, p.contextId, reply)
        : buildFailedTask(p.taskId, p.contextId, TASK_FAILED_TEXT);
    return (await stub.saveTask(terminal)) ? terminal : null;
  });
  if (!task) return;

  // Notify the gateway: a card-key-signed callback POST. Retried by the step on a
  // non-2xx; the terminal messageId is deterministic and the gateway is
  // idempotent/single-use, so retries are safe. If it ultimately fails, the
  // gateway's own reaction backstop clears the ⏳.
  await step.do("notify", async () => {
    const jwt = await signCallbackJwt(parsePrivateJwk(env.A2A_SIGNING_KEY), {
      jku: p.jku,
      aud: p.pushUrl
    });
    const res = await postNotification(p.pushUrl, p.pushToken, jwt, task);
    if (!res.ok) {
      throw new Error(`gateway notification failed: HTTP ${res.status}`);
    }
  });
}
