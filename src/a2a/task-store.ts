import type { TaskStore } from "@a2a-js/sdk/server";
import type { Task } from "@a2a-js/sdk";
import type { GatewayIdentity } from "./verify";
import { getAgent } from "@/proactive-agent";

/**
 * A durable {@link TaskStore} for the a2a-js `DefaultRequestHandler`, backed by
 * the caller's {@link file://../proactive-agent/index.ts ProactiveAgent} Durable
 * Object (via native RPC) instead of the SDK's per-request `InMemoryTaskStore`.
 *
 * Task state must survive the accept → async callback gap (and answer
 * `tasks/get`/`tasks/cancel` across requests), so it lives in the same per-caller
 * DO that owns the Session — keyed by the verified `identity.key`, exactly like
 * {@link file://./executor.ts A2AExecutor}. The workflow updates the same rows
 * through its own DO RPC calls, so this store and the workflow share one source
 * of truth.
 */
export class DurableTaskStore implements TaskStore {
  constructor(private readonly identity: GatewayIdentity) {}

  async load(taskId: string): Promise<Task | undefined> {
    return (await getAgent(this.identity).getTask(taskId)) ?? undefined;
  }

  async save(task: Task): Promise<void> {
    await getAgent(this.identity).saveTask(task);
  }
}
