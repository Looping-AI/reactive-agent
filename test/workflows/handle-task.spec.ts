import { afterEach, describe, it, expect, vi } from "vitest";
import { importJWK, jwtVerify } from "jose";
import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import type { Task } from "@a2a-js/sdk";
import type { ReactiveAgent } from "@/reactive-agent";
import { runHandleTask, type HandleTaskParams } from "@/workflows/handle-task";
import {
  TEST_AGENT_PRIVATE_JWK,
  GATEWAY_ORIGIN,
  AGENT_ORIGIN
} from "../fixtures";

const PUSH_URL = `${GATEWAY_ORIGIN}/a2a/notifications`;

/** Records what the workflow drove on the DO. */
interface StubCapture {
  working?: string;
  converse?: { text: string; identity: unknown; push: unknown };
  completed?: { task: Task };
  reply: string;
  currentState?: Task["status"]["state"];
}

/** A `step` that just runs each callback inline (no durability/retry in tests). */
const inlineStep = {
  do: (async (_name: string, a: unknown, b?: unknown) => {
    const cb = (typeof a === "function" ? a : b) as (ctx: unknown) => unknown;
    return cb({});
  }) as WorkflowStep["do"]
} as unknown as WorkflowStep;

function params(): HandleTaskParams {
  return {
    taskId: "task-1",
    text: "hi there",
    identity: { key: "custom:1:ada", name: "Ada", kind: "custom" },
    contextId: "ctx-1",
    pushUrl: PUSH_URL,
    pushToken: "tok-xyz",
    jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
  };
}

async function agentPublicKey() {
  const { d: _d, ...pub } = TEST_AGENT_PRIVATE_JWK;
  void _d;
  return importJWK(pub, "EdDSA");
}

/** Spy on the global ReactiveAgent namespace to return a fake stub. */
function mockAgent(cap: StubCapture) {
  const stub = {
    markWorking: vi.fn(async (id: string) => {
      cap.working = id;
    }),
    converse: vi.fn(async (text: string, identity: unknown, push: unknown) => {
      cap.converse = { text, identity, push };
      return cap.reply;
    }),
    getTask: vi.fn(async (): Promise<Task | null> =>
      cap.currentState
        ? ({ status: { state: cap.currentState } } as unknown as Task)
        : null
    ),
    completeTask: vi.fn(async (task: Task) => {
      cap.completed = { task };
    })
  } as unknown as DurableObjectStub<ReactiveAgent>;
  vi.spyOn(env.ReactiveAgent, "get").mockReturnValue(stub);
  return stub;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HandleTaskWorkflow", () => {
  it("generates the reply and POSTs a signed completed-Task callback to the gateway", async () => {
    const cap: StubCapture = { reply: "the answer" };
    mockAgent(cap);

    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.init = init;
        return new Response("ok", { status: 200 });
      })
    );

    await runHandleTask(params(), inlineStep);

    // Drove the DO: working → converse(text, identity) → completeTask.
    expect(cap.working).toBe("task-1");
    expect(cap.converse?.text).toBe("hi there");
    expect((cap.converse?.identity as { key: string }).key).toBe(
      "custom:1:ada"
    );
    // The push context is threaded to the DO so it can stream working callbacks.
    expect(cap.converse?.push).toMatchObject({
      taskId: "task-1",
      contextId: "ctx-1",
      pushUrl: PUSH_URL,
      pushToken: "tok-xyz"
    });
    expect(cap.completed?.task.status.state).toBe("completed");

    // POSTed to the gateway webhook with the validation token + signed JWT.
    expect(captured.url).toBe(PUSH_URL);
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("x-a2a-notification-token")).toBe("tok-xyz");

    const bearer =
      headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const { payload } = await jwtVerify(bearer, await agentPublicKey(), {
      audience: PUSH_URL,
      algorithms: ["EdDSA"]
    });
    expect(payload.aud).toBe(PUSH_URL);

    const body = JSON.parse(captured.init?.body as string) as Task;
    expect(body.kind).toBe("task");
    expect(body.id).toBe("task-1");
    expect(body.status.state).toBe("completed");
    expect(body.status.message?.parts?.[0]).toMatchObject({
      kind: "text",
      text: "the answer"
    });
  });

  it("skips the callback when the task was canceled before completion", async () => {
    const cap: StubCapture = { reply: "the answer", currentState: "canceled" };
    mockAgent(cap);
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await runHandleTask(params(), inlineStep);

    expect(cap.completed).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
