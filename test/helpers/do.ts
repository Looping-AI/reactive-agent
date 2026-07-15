import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AgentDB } from "@/db/db";

const ns = env.ReactiveAgent;

/** Fresh, unique DO stub per test — state never leaks between tests. */
export function freshStub(label: string) {
  return ns.get(ns.idFromName(`test:${label}:${crypto.randomUUID()}`));
}

/**
 * `ctx` is protected in the DO type system but public at runtime.
 * Cast once so callers don't repeat the assertion.
 */
export function doStorage(instance: unknown): DurableObjectStorage {
  return (instance as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

/**
 * Run `fn` inside a fresh DO instance with `AgentDB.tasks` already wired up.
 * Use this for tests that only need the tasks data layer; fall back to
 * `runInDurableObject` directly when raw `instance` access is also required.
 */
export function withTasks<T>(
  label: string,
  fn: (tasks: AgentDB["tasks"]) => T
) {
  return runInDurableObject(freshStub(label), (instance) => {
    const { tasks } = new AgentDB(doStorage(instance));
    return fn(tasks);
  });
}

/**
 * Run `fn` inside a fresh DO instance with `AgentDB.subtasks` already wired up.
 * Mirrors {@link withTasks} for the subtasks data layer.
 */
export function withSubtasks<T>(
  label: string,
  fn: (subtasks: AgentDB["subtasks"]) => T
) {
  return runInDurableObject(freshStub(label), (instance) => {
    const { subtasks } = new AgentDB(doStorage(instance));
    return fn(subtasks);
  });
}
