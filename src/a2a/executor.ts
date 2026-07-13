import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import type { PushNotificationConfig } from "@a2a-js/sdk";
import { env } from "cloudflare:workers";
import type { GatewayIdentity } from "./verify";
import type { HandleTaskParams } from "@/workflows/handle-task";
import { getAgent } from "@/reactive-agent";
import { inboundText } from "./inbound";

/** Per-request config the outer Worker extracts from `message/send` and injects. */
export interface ExecutorConfig {
  /** The gateway's callback webhook + validation token (required for `message/send`). */
  pushConfig?: PushNotificationConfig;
  /** This agent's card-signing JWKS URL — the callback JWT `jku`. */
  jku: string;
}

/**
 * Derive the deterministic {@link HandleTaskWorkflow} instance id for a turn. Keyed
 * on the gateway's `messageId` (stable across dispatch retries), so re-creating it
 * is a no-op — the turn runs exactly once. Sanitized to the id charset.
 */
export function workflowIdForMessage(messageId: string): string {
  return `handle-${messageId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * A2A executor for the **async accept + notify** contract. On `message/send` it no
 * longer blocks on generation: it records a `submitted` Task in the caller's DO
 * (idempotent on `messageId`), hands the turn to a durable
 * {@link file://../workflows/handle-task.ts HandleTaskWorkflow}, and publishes the
 * accepted Task immediately as the response. The workflow generates the reply and
 * POSTs it to the gateway's push-notification webhook out of band.
 *
 * The verified caller identity + the request's push config come from the
 * constructor: the outer Worker builds one executor per verified request.
 */
export class A2AExecutor implements AgentExecutor {
  constructor(
    private readonly identity: GatewayIdentity,
    private readonly cfg: ExecutorConfig
  ) {}

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const pushConfig = this.cfg.pushConfig;
    // Defensive: the Worker validates url + token before the executor runs.
    if (!pushConfig?.url || !pushConfig.token) {
      throw new Error("pushNotificationConfig url and token are required");
    }

    const text = inboundText(requestContext.userMessage);
    const messageId = requestContext.userMessage.messageId;
    const contextId = requestContext.contextId;

    // `identity.key` is guaranteed non-null: the Worker rejects a keyless identity
    // (400) before constructing this executor.
    const stub = getAgent(this.identity);

    // Record (or reuse) the submitted Task, then start the durable workflow. Both
    // are idempotent, so a dispatch retry heals a crash between the two.
    const task = await stub.beginTask({
      messageId,
      taskId: requestContext.taskId,
      contextId
    });

    await this.startWorkflow(messageId, {
      taskId: task.id,
      text,
      identity: this.identity,
      contextId,
      pushUrl: pushConfig.url,
      pushToken: pushConfig.token,
      jku: this.cfg.jku
    });

    // The accept ack: a `submitted` Task, not a Message. Returned synchronously.
    eventBus.publish(task);
    eventBus.finished();
  };

  /** Start the turn workflow; swallow the "instance already exists" retry race. */
  private async startWorkflow(
    messageId: string,
    params: HandleTaskParams
  ): Promise<void> {
    try {
      await env.HANDLE_TASK_WORKFLOW.create({
        id: workflowIdForMessage(messageId),
        params
      });
    } catch (err) {
      if (err instanceof Error && /exist/i.test(err.message)) return;
      throw err;
    }
  }

  /**
   * `tasks/cancel`: best-effort mark the task canceled in the DO and publish the
   * canceled Task. The in-flight workflow's `notify` step skips a canceled task.
   */
  cancelTask = async (
    taskId: string,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const task = await getAgent(this.identity).cancelTask(taskId);
    if (task) eventBus.publish(task);
    eventBus.finished();
  };
}
