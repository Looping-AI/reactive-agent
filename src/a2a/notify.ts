import { SignJWT, importJWK, type JWK } from "jose";
import type { Task } from "@a2a-js/sdk";
import type { PlainTask } from "./task";

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

/**
 * The `submitted` Task we return synchronously to accept a turn (A2A §7.2). The
 * gateway only requires `kind:"task"` + a non-empty `id`; the actual reply
 * follows later via the callback.
 */
export function buildSubmittedTask(
  taskId: string,
  contextId: string
): PlainTask {
  return {
    kind: "task",
    id: taskId,
    contextId,
    status: { state: "submitted", timestamp: new Date().toISOString() }
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
  state: "working" | "completed",
  text: string,
  messageId: string
): PlainTask {
  return {
    kind: "task",
    id: taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: {
        kind: "message",
        role: "agent",
        messageId,
        parts: [{ kind: "text", text }],
        contextId
      }
    }
  };
}

/**
 * A non-terminal `working` Task snapshot carrying an intermediate content message.
 * Streamed live from the DO as the tool loop emits content before the final reply.
 * `messageId` is derived from `${taskId}:${stepIndex}` — stable across re-runs (see
 * {@link buildTaskUpdate}) so the gateway dedupes correctly on workflow replay.
 */
export function buildWorkingTask(
  taskId: string,
  contextId: string,
  text: string,
  stepIndex: number
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    "working",
    text,
    `${taskId}:${stepIndex}`
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
    "completed",
    reply,
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
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
      [NOTIFICATION_TOKEN_HEADER]: token
    },
    body: JSON.stringify(task)
  });
}
