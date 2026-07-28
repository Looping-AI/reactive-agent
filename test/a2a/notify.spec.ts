import { describe, it, expect, vi, afterEach } from "vitest";
import { importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import { A2A_CONTENT_TYPE, Role, TaskState } from "@a2a-js/sdk";
import {
  buildSubmittedTask,
  buildCompletedTask,
  buildFailedTask,
  buildWorkingTask,
  signCallbackJwt,
  postNotification,
  NOTIFICATION_TOKEN_HEADER,
  TASK_FAILED_TEXT
} from "@/a2a/notify";
import type { PlainTask } from "@/a2a/task";
import { TEST_AGENT_PRIVATE_JWK } from "../fixtures";

const JKU = "https://agent.example.com/.well-known/jwks.json";

/** Concatenate the text of a Task's status message, v1.0 `content` oneof and all. */
function statusText(task: PlainTask): string {
  return (task.status.message?.parts ?? [])
    .flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : []))
    .join("");
}
const AUD = "https://gateway.test/a2a/notifications";

async function agentPublicKey() {
  const { d: _d, ...pub } = TEST_AGENT_PRIVATE_JWK;
  void _d;
  return importJWK(pub, "EdDSA");
}

describe("buildSubmittedTask", () => {
  it("is a submitted Task with the given id + contextId", () => {
    const task = buildSubmittedTask("task-1", "ctx-1");
    expect(task.id).toBe("task-1");
    expect(task.contextId).toBe("ctx-1");
    expect(task.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  });
});

describe("buildCompletedTask", () => {
  it("is a completed Task carrying the reply in status.message (where the gateway reads it)", () => {
    const task = buildCompletedTask("task-1", "ctx-1", "the answer");
    expect(task.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(statusText(task)).toBe("the answer");
    expect(task.status.message?.role).toBe(Role.ROLE_AGENT);
  });

  it("uses a deterministic ${taskId}:final messageId (stable across notify-step retries)", () => {
    const a = buildCompletedTask("task-1", "ctx-1", "the answer");
    const b = buildCompletedTask("task-1", "ctx-1", "the answer");
    expect(a.status.message?.messageId).toBe("task-1:final");
    expect(b.status.message?.messageId).toBe("task-1:final");
  });
});

describe("buildFailedTask", () => {
  it("is a failed Task carrying user-safe text in status.message", () => {
    const task = buildFailedTask("task-1", "ctx-1", TASK_FAILED_TEXT);
    expect(task.status.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(task.status.message?.role).toBe(Role.ROLE_AGENT);
    expect(statusText(task)).toBe(TASK_FAILED_TEXT);
  });

  it("shares the deterministic ${taskId}:final messageId with the completed builder", () => {
    // A Task terminates exactly once and the two states are mutually exclusive,
    // so the delivery step only ever builds one of them — reusing the key keeps
    // the gateway's dedupe correct across notify retries either way.
    const failed = buildFailedTask("task-1", "ctx-1", "nope");
    expect(failed.status.message?.messageId).toBe("task-1:final");
    expect(failed.status.message?.messageId).toBe(
      buildCompletedTask("task-1", "ctx-1", "yep").status.message?.messageId
    );
  });

  it("never leaks an internal diagnostic into the default text", () => {
    expect(TASK_FAILED_TEXT).not.toMatch(/model|subtask|branch|error:/i);
  });
});

describe("buildWorkingTask", () => {
  it("is a working Task carrying the given intermediate text + messageId", () => {
    const task = buildWorkingTask("task-1", "ctx-1", "progress…", "step:0");
    expect(task.status.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(task.id).toBe("task-1");
    expect(task.contextId).toBe("ctx-1");
    expect(task.status.message?.role).toBe(Role.ROLE_AGENT);
    expect(task.status.message?.messageId).toBe("task-1:step:0");
    expect(statusText(task)).toBe("progress…");
  });

  it("keys milestone messages by their semantic phase", () => {
    const task = buildWorkingTask("task-1", "ctx-1", "On it.", "decompose");
    expect(task.status.message?.messageId).toBe("task-1:decompose");
  });

  it("keeps phase, tool-step, and terminal ids in distinct namespaces", () => {
    // The gateway dedupes on messageId, so a milestone must never collide with a
    // tool-loop step or the terminal message.
    const ids = [
      buildWorkingTask("task-1", "ctx-1", "a", "step:0").status.message
        ?.messageId,
      buildWorkingTask("task-1", "ctx-1", "b", "decompose").status.message
        ?.messageId,
      buildCompletedTask("task-1", "ctx-1", "c").status.message?.messageId
    ];
    expect(new Set(ids).size).toBe(3);
  });
});

describe("signCallbackJwt", () => {
  it("signs an EdDSA JWT whose header pins the card kid+jku and verifies with the public key", async () => {
    const jwt = await signCallbackJwt(TEST_AGENT_PRIVATE_JWK, {
      jku: JKU,
      aud: AUD
    });

    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(header.jku).toBe(JKU);

    const { payload } = await jwtVerify(jwt, await agentPublicKey(), {
      audience: AUD,
      algorithms: ["EdDSA"]
    });
    expect(payload.aud).toBe(AUD);
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBeTypeOf("number");
  });

  it("rejects verification against the wrong audience", async () => {
    const jwt = await signCallbackJwt(TEST_AGENT_PRIVATE_JWK, {
      jku: JKU,
      aud: AUD
    });
    await expect(
      jwtVerify(jwt, await agentPublicKey(), {
        audience: "https://evil.test/a2a/notifications",
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });
});

describe("postNotification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the Task with the token header and Bearer JWT", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.init = init;
        return new Response("ok", { status: 200 });
      })
    );

    const task = buildCompletedTask("task-1", "ctx-1", "hi");
    const res = await postNotification(AUD, "tok-123", "jwt-abc", task);

    expect(res.status).toBe(200);
    expect(captured.url).toBe(AUD);
    expect(captured.init?.method).toBe("POST");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get(NOTIFICATION_TOKEN_HEADER)).toBe("tok-123");
    expect(headers.get("authorization")).toBe("Bearer jwt-abc");
    expect(headers.get("content-type")).toBe(A2A_CONTENT_TYPE);
  });

  it("sends the A2A v1.0 wire body: a StreamResponse-wrapped Task, JSON-encoded", async () => {
    // This is the regression this test exists for. The in-memory protobuf shape
    // is not the wire shape, so a plain `JSON.stringify(task)` would emit a
    // numeric `state` and a `{ $case, value }` part wrapper — parseable JSON that
    // no A2A peer accepts. The gateway also needs the `task` payload key to know
    // which event shape this is, now that v1.0 has dropped `kind`.
    const captured: { init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured.init = init;
        return new Response("ok", { status: 200 });
      })
    );

    const task = buildCompletedTask("task-1", "ctx-1", "hi");
    await postNotification(AUD, "tok-123", "jwt-abc", task);

    expect(JSON.parse(captured.init?.body as string)).toEqual({
      task: {
        id: "task-1",
        contextId: "ctx-1",
        status: {
          state: "TASK_STATE_COMPLETED",
          timestamp: expect.any(String),
          message: {
            messageId: "task-1:final",
            contextId: "ctx-1",
            taskId: "task-1",
            role: "ROLE_AGENT",
            parts: [{ text: "hi", mediaType: "text/plain" }]
          }
        }
      }
    });
  });
});
