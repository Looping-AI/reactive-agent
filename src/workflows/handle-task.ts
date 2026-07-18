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
import { MAX_SUBTASKS, MAX_CHUNKS_PER_BRANCH } from "@/config";

/**
 * The async task controller. The gateway no longer waits for a synchronous reply:
 * the Worker accepts a turn (returns a `submitted` Task) and hands the actual work
 * to this durable Workflow, which orchestrates it end to end and delivers the
 * reply to the gateway's push-notification webhook.
 *
 * The five phases:
 *
 * 0. **Pre-work** — resolve the caller's agent, mark the Task working.
 * 1. **Decompose** — one main-agent inference turns the Task into 1..8 durable
 *    Subtasks and the first user-visible reply.
 * 2. **Execute** — run the Subtask DAG in waves, every dependency-ready node
 *    concurrently, each in an isolated managed subagent.
 * 3. **Compose** — one main-agent inference merges the branches into a final
 *    reply (bypassed for a single Subtask).
 * 4. **Deliver** — persist the terminal Task, then POST a signed callback.
 *
 * Why a Workflow (not a DO alarm / `waitUntil`): `step.do(...)` gives durable,
 * independently-retried steps that survive isolate eviction, and a future
 * human-approval interrupt slots in cleanly as a `step.waitForEvent(...)` before
 * delivery.
 *
 * A Workflow is a separate entrypoint and cannot touch the agent DO's SQLite
 * directly, so: the task inputs travel as the workflow **payload**, and the agent
 * runtime + task state are reached only through **native DO RPC** — see
 * {@link file://../reactive-agent/index.ts}.
 *
 * Idempotency: the instance id is derived from the gateway's `messageId`
 * (deterministic across dispatch retries), so a re-dispatch never starts a second
 * run. Within a run, every phase is re-runnable: the Subtask rows and the Session
 * are the source of truth, and each phase recovers from them rather than
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
 */
export async function runHandleTask(
  p: HandleTaskParams,
  step: WorkflowStep
): Promise<void> {
  // Phase 0: Pre-work. Routing is pure, so it needs no step of its own.
  const stub = getAgent(p.identity);
  const push: TurnPushContext = {
    taskId: p.taskId,
    contextId: p.contextId,
    pushUrl: p.pushUrl,
    pushToken: p.pushToken,
    jku: p.jku
  };

  const started = await step.do("working", async () => {
    if (await isCanceled(stub, p.taskId)) return false;
    await stub.markWorking(p.taskId);
    return true;
  });
  if (!started) return;

  // Phase 1: Decompose Task. `decomposeTask` persists the Subtask rows and emits
  // the first `working` reply itself, so this step returns only the verdict. A
  // typed `failed` is a real outcome (both models produced unusable output) and
  // routes to failed delivery; a transient fault throws and the step retries,
  // recovering from the durable rows with no second inference.
  const decomposed = await step.do("decompose", async () => {
    const result = await stub.decomposeTask({
      taskId: p.taskId,
      text: p.text,
      identity: p.identity,
      push
    });
    return result.status === "completed"
      ? { ok: true as const }
      : { ok: false as const, error: result.error };
  });

  if (!decomposed.ok) {
    console.error("[handle-task] decomposition failed", {
      taskId: p.taskId,
      error: decomposed.error
    });
    await deliver(p, step, stub, null);
    return;
  }

  // Phase 2: Execute Subtasks.
  const executed = await executeDag(p, step, stub, push);
  if (executed === "canceled") return;
  if (executed === "stuck") {
    await deliver(p, step, stub, null);
    return;
  }

  // Phase 3: Compose Task. The single-Subtask bypass and the "no branch
  // succeeded" failure both live inside `composeTask`; this only routes.
  const composed = await step.do("compose", async () => {
    if (await isCanceled(stub, p.taskId))
      return { status: "canceled" as const };
    return await stub.composeTask({ taskId: p.taskId, identity: p.identity });
  });
  if (composed.status === "canceled") return;

  if (composed.status === "failed") {
    console.error("[handle-task] composition failed", {
      taskId: p.taskId,
      error: composed.error
    });
    await deliver(p, step, stub, null);
    return;
  }

  // Phase 4: Deliver Task.
  await deliver(p, step, stub, composed.reply);
}

/** How Phase 2 ended. `stuck` is an invariant violation — see {@link selectWave}. */
type DagOutcome = "done" | "canceled" | "stuck";

/**
 * Phase 2: drive the Subtask DAG to termination, one wave at a time.
 *
 * Bounded by `MAX_SUBTASKS + 1` iterations rather than looping until `done`: a
 * wave that reports `ready` always retires at least one active node, so 8
 * Subtasks need at most 8 waves of work plus one final scan to observe `done`.
 * Exhausting the budget means the DAG stopped making progress, which is the same
 * corruption `stuck` names.
 */
async function executeDag(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  push: TurnPushContext
): Promise<DagOutcome> {
  for (let wave = 0; wave <= MAX_SUBTASKS; wave++) {
    // One durable step per wave: re-check cancellation, propagate skips past any
    // branch that just failed, and read back the refreshed DAG projection.
    const scan = await step.do(`scan:${wave}`, async () => {
      if (await isCanceled(stub, p.taskId)) {
        return { canceled: true as const, nodes: [] };
      }
      return {
        canceled: false as const,
        nodes: await stub.skipBlockedSubtasks(p.taskId)
      };
    });

    if (scan.canceled) {
      await step.do(`cancel:${wave}`, async () => {
        await stub.cancelPendingSubtasks(p.taskId);
      });
      return "canceled";
    }

    const decision = selectWave(scan.nodes);
    if (decision.kind === "done") return "done";
    if (decision.kind === "stuck") {
      console.error("[handle-task] subtask DAG made no progress", {
        taskId: p.taskId,
        wave,
        active: decision.active
      });
      return "stuck";
    }

    // Every dependency-ready node runs concurrently — the 8-Subtask maximum is
    // the only fan-out bound. `runBranch` never rejects, so a single branch
    // cannot fast-fail `Promise.all` and strand its siblings' durable results.
    await Promise.all(
      decision.ids.map((id) => runBranch(p, step, stub, id, push))
    );
  }

  console.error("[handle-task] subtask DAG exceeded its wave budget", {
    taskId: p.taskId
  });
  return "stuck";
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
 * means nobody is left to resolve this row: fail *the branch* and let Phase 3
 * disclose the gap, rather than discarding the durable work its siblings finished.
 */
async function runBranch(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  id: SubtaskId,
  push: TurnPushContext
): Promise<void> {
  try {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_BRANCH; chunk++) {
      // Chunk 0 keeps the historic `execute:<id>` step name so single-chunk
      // branches replay byte-identically; later chunks append `:chunk:<n>`.
      const stepName =
        chunk === 0 ? `execute:${id}` : `execute:${id}:chunk:${chunk}`;
      const done = await step.do(stepName, async () => {
        // The DO posts any progress itself; the step returns only the verdict.
        const outcome = await stub.executeSubtaskChunk(id, chunk, push);
        return outcome.done;
      });
      if (done) return;
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
  } catch (err) {
    console.error("[handle-task] subtask execution exhausted retries", {
      taskId: p.taskId,
      subtaskId: id,
      err: String(err)
    });
    await step.do(`fail:${id}`, async () => {
      await stub.failSubtask(id, `execution exhausted retries: ${String(err)}`);
    });
  }
}

/**
 * Phase 4: persist the terminal Task, then notify the gateway. A null `reply`
 * delivers a `failed` Task with user-safe text; the diagnostic is already logged.
 *
 * The Task is built **inside** the step and returned, so `notify` posts exactly
 * what was persisted: building it in the body would re-stamp `new Date()` on
 * every replay and post a Task that differs from the stored one.
 */
async function deliver(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  reply: string | null
): Promise<void> {
  const task = await step.do("complete", async () => {
    if (await isCanceled(stub, p.taskId)) return null;
    const terminal =
      reply !== null
        ? buildCompletedTask(p.taskId, p.contextId, reply)
        : buildFailedTask(p.taskId, p.contextId, TASK_FAILED_TEXT);
    await stub.saveTask(terminal);
    return terminal;
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

/**
 * Whether the caller canceled this Task. Read fresh before every phase that would
 * start new work or publish output; `executeSubtask` re-checks on its own side
 * around the model call, where the window is widest.
 */
async function isCanceled(stub: AgentStub, taskId: string): Promise<boolean> {
  const current = await stub.getTask(taskId);
  return current?.status.state === "canceled";
}
