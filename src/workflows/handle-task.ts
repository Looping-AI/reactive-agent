import { WorkflowEntrypoint, env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { GatewayIdentity } from "@/a2a/verify";
import { parsePrivateJwk } from "@/a2a/card";
import {
  buildCompletedTask,
  postNotification,
  signCallbackJwt
} from "@/a2a/notify";
import { getAgent } from "@/reactive-agent";

/**
 * The async turn controller. The gateway no longer waits for a synchronous reply:
 * the Worker accepts a turn (returns a `submitted` Task) and hands the actual work
 * to this durable Workflow, which orchestrates it end to end and delivers the
 * reply to the gateway's push-notification webhook.
 *
 * Why a Workflow (not a DO alarm / `waitUntil`): `step.do(...)` gives durable,
 * independently-retried steps that survive isolate eviction, and a future
 * human-approval interrupt slots in cleanly as a `step.waitForEvent(...)` between
 * generation and delivery.
 *
 * A Workflow is a separate entrypoint and cannot touch the agent DO's SQLite
 * directly, so: the turn inputs travel as the workflow **payload**, and the agent
 * runtime + task state are reached only through **native DO RPC** (`converse`,
 * `markWorking`, `completeTask`) — see {@link file://../reactive-agent/index.ts}.
 *
 * Idempotency: the instance id is derived from the gateway's `messageId`
 * (deterministic across dispatch retries), so a re-dispatch never starts a second
 * run — `converse` executes exactly once.
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
 * `cloudflare:workers` import rather than a parameter. Steps are named so
 * retries are durable and idempotent.
 */
export async function runHandleTask(
  p: HandleTaskParams,
  step: WorkflowStep
): Promise<void> {
  const stub = getAgent(p.identity);

  await step.do("working", async () => {
    await stub.markWorking(p.taskId);
  });

  // Generate the reply. Durable + retried; `converse` resolves its own transient
  // failures to a friendly string, so a throw here is a genuine RPC fault. The
  // push context lets the DO stream intermediate `working` callbacks live during
  // generation; this step still returns only the terminal reply text.
  const reply = await step.do("generate", () =>
    stub.converse(p.text, p.identity, {
      taskId: p.taskId,
      contextId: p.contextId,
      pushUrl: p.pushUrl,
      pushToken: p.pushToken,
      jku: p.jku
    })
  );

  const task = buildCompletedTask(p.taskId, p.contextId, reply);

  // Persist the terminal task, unless the caller canceled it meanwhile.
  const canceled = await step.do("complete", async () => {
    const current = await stub.getTask(p.taskId);
    if (current?.status.state === "canceled") return true;
    await stub.completeTask(task);
    return false;
  });
  if (canceled) return;

  // Notify the gateway: a card-key-signed callback POST. Retried by the step on a
  // non-2xx; the gateway is idempotent/single-use, so retries are safe. If it
  // ultimately fails, the gateway's own reaction backstop clears the ⏳.
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
