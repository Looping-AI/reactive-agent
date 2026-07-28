import type { Message, Task, TaskStatus } from "@a2a-js/sdk";

/**
 * The A2A `Task` as it crosses the DO RPC boundary.
 *
 * Cloudflare's generated DO-stub types run every return value through
 * `Serializable<T>`, and the SDK `Task` is more than that machinery can chew on:
 * under A2A v0.3 the open-ended `unknown` metadata collapsed stub returns to
 * `never`, and under v1.0 the same fields — now `any`, plus the four-branch
 * `Part.content` oneof (one branch of which is a `Buffer`) — instead blow past
 * TypeScript's instantiation-depth limit. Either way the boundary needs a type
 * small enough to expand.
 *
 * So this narrows `Task` to the shape this agent actually produces: text parts
 * only, no artifacts, no history, no extension metadata (see
 * {@link file://./notify.ts}). It stays a structural **subtype** of the SDK
 * `Task`, so it widens back for free at the a2a-js edges (`AgentEvent.task`,
 * `TaskStore.load`) with no cast. Runtime is unaffected — tasks are
 * JSON-round-tripped through storage, so fields this type doesn't name still
 * survive.
 *
 * If a DO method starts returning `never`, or tsc reports an "excessively deep"
 * instantiation at one of those edges, the SDK grew another field that does not
 * survive `Serializable` — narrow it here too.
 */

/** We only ever build text parts (see {@link file://./notify.ts}). */
export type PlainPart = {
  content: { $case: "text"; value: string };
  metadata: undefined;
  filename: string;
  mediaType: string;
};

type PlainMessage = Omit<Message, "parts" | "metadata"> & {
  parts: PlainPart[];
  metadata: undefined;
};

// `message` stays a *required* key (holding `undefined` when there is no
// message), matching `TaskStatus`. Making it optional would break the subtype
// relation the widening guard below enforces.
type PlainStatus = Omit<TaskStatus, "message"> & {
  message: PlainMessage | undefined;
};

export type PlainTask = Omit<
  Task,
  "status" | "metadata" | "artifacts" | "history"
> & {
  status: PlainStatus;
  metadata: undefined;
  artifacts: never[];
  history: never[];
};

// Compile-time guard: `PlainTask` must stay a structural subtype of the SDK `Task`
// so it widens with no cast at the a2a-js boundaries. Fails the build otherwise.
type _Widens = PlainTask extends Task ? true : never;
const _assertWidens: _Widens = true;
void _assertWidens;
