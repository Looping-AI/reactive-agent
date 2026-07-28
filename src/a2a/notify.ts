import { SignJWT, importJWK, type JWK } from "jose";
import {
  A2A_CONTENT_TYPE,
  Role,
  StreamResponse,
  TaskState,
  type Task
} from "@a2a-js/sdk";
import type { PlainPart, PlainTask } from "./task";

/**
 * Outbound push-notification (accept + notify) helpers — the "notify" half of the
 * async A2A contract. The gateway dispatches `message/send` with a
 * `pushNotificationConfig` (webhook `url` + validation `token`), we accept
 * immediately with a `submitted` Task, and later POST the terminal Task back to
 * that webhook. This module builds the Task shapes and signs + sends that
 * callback.
 *
 * The callback is authenticated exactly like the AgentCard: a short-lived EdDSA
 * JWT signed by `A2A_SIGNING_KEY`, whose protected header `kid`+`jku` must equal
 * the card's signing `kid`+`jku` (see {@link file://./card.ts} `signCard`) — the
 * gateway pinned those at registration (Trust-On-First-Use) and verifies the
 * callback token against that same public JWKS. No shared secret crosses the
 * boundary; only our public key is ever used to verify.
 */

/** JWS algorithm — must match the card + gateway (`EdDSA`). */
const ALG = "EdDSA";

/**
 * Header carrying the per-task validation `token` the gateway set in the
 * `pushNotificationConfig`. Echoed verbatim so the gateway can correlate the
 * callback to its pending task row. Must match looping-gateway's
 * `NOTIFICATION_TOKEN_HEADER` (`src/a2a/notifications.ts`).
 */
export const NOTIFICATION_TOKEN_HEADER = "x-a2a-notification-token";

/**
 * Callback-JWT lifetime. The gateway enforces `maxTokenAge: 10m` with a 60s clock
 * tolerance, so keep this comfortably under that.
 */
const CALLBACK_TOKEN_TTL = "5m";

/** A v1.0 text part: the `content` oneof plus its required siblings. */
function textPart(text: string): PlainPart {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain"
  };
}

/**
 * The `submitted` Task we return synchronously to accept a turn (A2A §7.2). The
 * gateway only requires a non-empty `id`; the actual reply follows later via the
 * callback. (v1.0 dropped the `kind` discriminator — a Task is identified by its
 * position in the response, or by the `StreamResponse` payload key on the wire.)
 */
export function buildSubmittedTask(
  taskId: string,
  contextId: string
): PlainTask {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_SUBMITTED,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

/**
 * A Task snapshot POSTed to the gateway callback in a given `state`, carrying one
 * `agent` message. The gateway's `extractText` reads `status.message.parts`, so
 * the text lives there. `messageId` is the gateway's per-message dedupe key, so
 * callers pass a **stable** id (never a fresh random per attempt) — a callback the
 * workflow/DO re-runs must reuse the same id or the gateway double-posts.
 */
function buildTaskUpdate(
  taskId: string,
  contextId: string,
  state:
    | TaskState.TASK_STATE_WORKING
    | TaskState.TASK_STATE_COMPLETED
    | TaskState.TASK_STATE_FAILED,
  text: string,
  messageId: string
): PlainTask {
  return {
    id: taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: {
        role: Role.ROLE_AGENT,
        messageId,
        parts: [textPart(text)],
        contextId,
        taskId,
        metadata: undefined,
        extensions: [],
        referenceTaskIds: []
      }
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

/**
 * A non-terminal `working` Task snapshot carrying a progress message. Streamed
 * live from the DO as the tool loop emits content, and emitted once per phase for
 * milestone replies (a delegating round's acknowledgement).
 *
 * `key` is a **stable semantic key** naming what produced the message, not a
 * counter: the tool loop passes `step:<n>`, decomposition passes `decompose`, and
 * the terminal callback uses `final` ({@link buildCompletedTask}). The resulting
 * `${taskId}:${key}` messageId is stable across re-runs (see
 * {@link buildTaskUpdate}) so the gateway dedupes correctly on workflow replay,
 * and the namespaces cannot collide by construction.
 */
export function buildWorkingTask(
  taskId: string,
  contextId: string,
  text: string,
  key: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_WORKING,
    text,
    `${taskId}:${key}`
  );
}

/**
 * The terminal `completed` Task POSTed to the gateway callback. The `messageId` is
 * deterministic (`${taskId}:final`, not a fresh UUID) because this is built in the
 * workflow body, which re-runs on replay: a random id would change on a notify-step
 * retry and the gateway would dedupe the final message as a new one and double-post.
 */
export function buildCompletedTask(
  taskId: string,
  contextId: string,
  reply: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_COMPLETED,
    reply,
    `${taskId}:final`
  );
}

/**
 * User-safe text for a terminal `failed` Task. The gateway renders this to a
 * human, so it says *that* the request failed and never *why*: the internal
 * diagnostics (which model, which branch, which fault) stay on the Subtask rows
 * and in the logs, where an operator can read them and an end user cannot.
 *
 * Deliberately terse. It rides on a `failed` Task, and the gateway prefixes that
 * with "⚠️ *Agent …* (failed):" — so an apology here would just say "something
 * broke" twice, and naming the agent would repeat what the prefix already shows.
 */
export const TASK_FAILED_TEXT =
  "Couldn't handle that request. Please try again — check the agent's logs " +
  "if it keeps happening.";

/**
 * The terminal `failed` Task POSTed to the gateway callback — decomposition
 * produced nothing runnable, or no branch survived.
 *
 * Shares the `${taskId}:final` messageId with {@link buildCompletedTask} by
 * design: a Task terminates exactly once, the two states are mutually exclusive,
 * and the workflow's delivery step is durable — so only one of them is ever built
 * and posted, and a notify retry re-posts that same one under the same dedupe key.
 */
export function buildFailedTask(
  taskId: string,
  contextId: string,
  text: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_FAILED,
    text,
    `${taskId}:final`
  );
}

/**
 * Sign the callback JWT the gateway verifies against our pinned card key. The
 * protected header mirrors the card signature (`kid`+`jku`); `aud` must equal the
 * exact webhook URL the gateway handed us in the `pushNotificationConfig`.
 */
export async function signCallbackJwt(
  privateJwk: JWK & { kid: string },
  opts: { jku: string; aud: string }
): Promise<string> {
  const key = await importJWK(privateJwk, ALG);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: privateJwk.kid, jku: opts.jku })
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(CALLBACK_TOKEN_TTL)
    .sign(key);
}

/**
 * The A2A v1.0 push-notification body for a Task snapshot: the Task wrapped in a
 * `StreamResponse` and encoded with the generated `toJSON`. This mirrors the
 * SDK's own `V1PushNotificationSerializer`, which is what a v1.0 gateway parses.
 *
 * Both halves matter. The wrapper is the v1.0 replacement for the removed `kind`
 * discriminator — the payload key (`task`) is what tells the receiver which of
 * the four event shapes this is, so a bare Task is no longer self-describing.
 * And `toJSON` is not optional: the in-memory protobuf shape is *not* the wire
 * shape (enums are numbers, oneofs are `{ $case, value }` wrappers), so a plain
 * `JSON.stringify(task)` would emit `"state": 3` and
 * `"parts": [{ "content": { "$case": "text", … } }]` — neither of which is valid
 * A2A JSON.
 */
export function notificationBody(task: Task): string {
  return JSON.stringify(
    StreamResponse.toJSON({ payload: { $case: "task", value: task } })
  );
}

/**
 * POST the terminal Task to the gateway's push-notification webhook. Returns the
 * raw `Response` so the caller (the workflow's `notify` step) can decide whether
 * a non-2xx warrants a retry.
 */
export async function postNotification(
  url: string,
  token: string,
  jwt: string,
  task: Task
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      // v1.0 registered its own media type; v0.3 used `application/json`.
      "content-type": A2A_CONTENT_TYPE,
      authorization: `Bearer ${jwt}`,
      [NOTIFICATION_TOKEN_HEADER]: token
    },
    body: notificationBody(task)
  });
}
