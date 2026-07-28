import type { TaskStore } from "@a2a-js/sdk/server";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import type { GatewayIdentity } from "./verify";
import { getAgent } from "@/reactive-agent";

/**
 * A durable {@link TaskStore} for the a2a-js `DefaultRequestHandler`, backed by
 * the caller's {@link file://../reactive-agent/index.ts ReactiveAgent} Durable
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

  /**
   * `ListTasks` is new in A2A v1.0 and required by the `TaskStore` interface, but
   * this agent does not implement it: the gateway drives every turn it started
   * through the `messageId` it already holds and reads individual rows back with
   * `GetTask`, so nothing needs to enumerate the DO's task table. Listing is also
   * the one operation here that would need real pagination over SQLite, which is
   * not worth building for a caller that never issues it.
   *
   * Refusing explicitly (rather than returning an empty page) keeps the failure
   * honest: an empty `tasks: []` would read as "this caller has no tasks", which
   * is a wrong answer rather than an absent one.
   */
  async list(_params: ListTasksRequest): Promise<ListTasksResponse> {
    throw new UnsupportedOperationError({
      message: "ListTasks is not supported by this agent"
    });
  }
}
