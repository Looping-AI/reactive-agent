import { describe, it, expect, vi, afterEach } from "vitest";
import { importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import type { Task } from "@a2a-js/sdk";
import {
  buildSubmittedTask,
  buildCompletedTask,
  buildWorkingTask,
  signCallbackJwt,
  postNotification,
  NOTIFICATION_TOKEN_HEADER
} from "@/a2a/notify";
import { TEST_AGENT_PRIVATE_JWK } from "../fixtures";

const JKU = "https://agent.example.com/.well-known/jwks.json";
const AUD = "https://gateway.test/a2a/notifications";

async function agentPublicKey() {
  const { d: _d, ...pub } = TEST_AGENT_PRIVATE_JWK;
  void _d;
  return importJWK(pub, "EdDSA");
}

describe("buildSubmittedTask", () => {
  it("is a submitted Task with the given id + contextId", () => {
    const task = buildSubmittedTask("task-1", "ctx-1");
    expect(task.kind).toBe("task");
    expect(task.id).toBe("task-1");
    expect(task.contextId).toBe("ctx-1");
    expect(task.status.state).toBe("submitted");
  });
});

describe("buildCompletedTask", () => {
  it("is a completed Task carrying the reply in status.message (where the gateway reads it)", () => {
    const task = buildCompletedTask("task-1", "ctx-1", "the answer");
    expect(task.status.state).toBe("completed");
    const parts = task.status.message?.parts ?? [];
    const text = parts
      .filter(
        (p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text"
      )
      .map((p) => p.text)
      .join("");
    expect(text).toBe("the answer");
    expect(task.status.message?.role).toBe("agent");
  });

  it("uses a deterministic ${taskId}:final messageId (stable across notify-step retries)", () => {
    const a = buildCompletedTask("task-1", "ctx-1", "the answer");
    const b = buildCompletedTask("task-1", "ctx-1", "the answer");
    expect(a.status.message?.messageId).toBe("task-1:final");
    expect(b.status.message?.messageId).toBe("task-1:final");
  });
});

describe("buildWorkingTask", () => {
  it("is a working Task carrying the given intermediate text + messageId", () => {
    const task = buildWorkingTask("task-1", "ctx-1", "progress…", "step:0");
    expect(task.status.state).toBe("working");
    expect(task.id).toBe("task-1");
    expect(task.contextId).toBe("ctx-1");
    expect(task.status.message?.role).toBe("agent");
    expect(task.status.message?.messageId).toBe("task-1:step:0");
    const parts = task.status.message?.parts ?? [];
    const text = parts
      .filter(
        (p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text"
      )
      .map((p) => p.text)
      .join("");
    expect(text).toBe("progress…");
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

    const task: Task = buildCompletedTask("task-1", "ctx-1", "hi");
    const res = await postNotification(AUD, "tok-123", "jwt-abc", task);

    expect(res.status).toBe(200);
    expect(captured.url).toBe(AUD);
    expect(captured.init?.method).toBe("POST");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get(NOTIFICATION_TOKEN_HEADER)).toBe("tok-123");
    expect(headers.get("authorization")).toBe("Bearer jwt-abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(captured.init?.body as string).id).toBe("task-1");
  });
});
