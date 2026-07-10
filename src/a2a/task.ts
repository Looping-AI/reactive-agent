import type { Task } from "@a2a-js/sdk";

type A2AStatus = Task["status"];
type A2AMessage = NonNullable<A2AStatus["message"]>;

/** We only ever build text parts (see {@link file://./notify.ts}). */
type PlainPart = { kind: "text"; text: string };
type PlainMessage = Omit<A2AMessage, "metadata" | "parts"> & {
  parts: PlainPart[];
};
type PlainStatus = Omit<A2AStatus, "message"> & { message?: PlainMessage };

/**
 * The A2A `Task` as it crosses the DO RPC boundary: the SDK `Task` derived with its
 * open-ended extension `metadata` stripped (that field's `unknown` collapses
 * Cloudflare's generated DO-stub return types to `never`, which is the entire reason
 * this type exists), along with the `history`/`artifacts` we never use.
 *
 * We derive from `Task` rather than hand-writing so benign new SDK fields flow
 * through automatically; the `unknown` also hides in `status.message.metadata` and
 * every `Part.metadata`, so `status` is overridden at each nested level. `PlainTask`
 * widens back to the SDK `Task` for free at the a2a-js edges (`eventBus.publish`,
 * `TaskStore.load`), so no cast is needed there. Runtime is unaffected — tasks are
 * JSON-round-tripped in storage, so any extra SDK fields survive even though this
 * type doesn't name them.
 *
 * If a DO method ever collapses to `never` again, the SDK grew a new
 * `unknown`-bearing field — add it to the `Omit` below.
 */
export type PlainTask = Omit<
  Task,
  "metadata" | "status" | "artifacts" | "history"
> & {
  status: PlainStatus;
};

// Compile-time guard: `PlainTask` must stay a structural subtype of the SDK `Task`
// so it widens with no cast at the a2a-js boundaries. Fails the build otherwise.
type _Widens = PlainTask extends Task ? true : never;
const _assertWidens: _Widens = true;
void _assertWidens;
