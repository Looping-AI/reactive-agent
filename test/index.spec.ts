import { afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "@/index";
import type { Task } from "@a2a-js/sdk";
import type { ReactiveAgent } from "@/reactive-agent";
import { buildSubmittedTask } from "@/a2a/notify";
import type { GatewayIdentity } from "@/a2a/verify";
import {
  GATEWAY_ORIGIN,
  AGENT_ORIGIN,
  TEST_AGENT_PRIVATE_JWK
} from "./fixtures";
import { makeGatewayToken } from "./helpers/auth";

const PUSH_URL = `${GATEWAY_ORIGIN}/a2a/notifications`;
const PUSH_TOKEN = "push-token-abc";

// Stub env for tests that only need config vars (auth/card/jwks paths) and
// do not exercise ReactiveAgent routing — ReactiveAgent is left undefined.
// Tests that go through message/send (which enqueues a Workflow and calls
// getAgent) or tasks/cancel (which spies on env.ReactiveAgent.get) pass
// the real miniflare `env` instead so the DO binding is live.
const TEST_ENV: Env = {
  A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  GATEWAY_ORIGINS: JSON.stringify([GATEWAY_ORIGIN]),
  ARC_API_KEY: "test-arc-key",
  AI: undefined as unknown as Ai,
  BROWSER: undefined as unknown as BrowserRun,
  ReactiveAgent: undefined as unknown as DurableObjectNamespace<ReactiveAgent>,
  VECTORIZE: undefined as unknown as VectorizeIndex,
  HANDLE_TASK_WORKFLOW: undefined as unknown as Env["HANDLE_TASK_WORKFLOW"]
};

// The worker's fetch handler only takes (request, env) — it never uses ctx.
async function req(
  method: string,
  path: string,
  init?: RequestInit,
  workerEnv: Env = env
) {
  return worker.fetch(
    new Request(`${AGENT_ORIGIN}${path}`, { method, ...init }),
    workerEnv
  );
}

/** A `message/send` JSON-RPC body carrying `text` (with or without a push config). */
function sendBody(
  text: string,
  opts: {
    push?: boolean;
    method?: string;
    pushConfig?: { url?: string; token?: string };
  } = {}
) {
  const { push = true, method = "message/send", pushConfig } = opts;
  const resolvedPushConfig = pushConfig ?? { url: PUSH_URL, token: PUSH_TOKEN };
  return {
    jsonrpc: "2.0",
    id: "1",
    method,
    params: {
      message: {
        messageId: "msg-test-1",
        role: "user",
        kind: "message",
        parts: [{ kind: "text", text }],
        contextId: "ctx-1"
      },
      ...(push
        ? {
            configuration: {
              pushNotificationConfig: resolvedPushConfig
            }
          }
        : {})
    }
  };
}

/** A `tasks/cancel` JSON-RPC body for `taskId`. */
function cancelBody(taskId: string) {
  return {
    jsonrpc: "2.0",
    id: "1",
    method: "tasks/cancel",
    params: { id: taskId }
  };
}

/** POST a JSON-RPC body with a valid gateway token for `identity`. */
async function postRpc(
  body: unknown,
  identity: Partial<GatewayIdentity>,
  workerEnv: Env = env
) {
  const token = await makeGatewayToken({ audience: AGENT_ORIGIN, identity });
  return req(
    "POST",
    "/a2a",
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      }
    },
    workerEnv
  );
}

afterEach(() => vi.restoreAllMocks());

describe("GET /.well-known/jwks.json", () => {
  it("returns 200", async () => {
    const res = await req("GET", "/.well-known/jwks.json");
    expect(res.status).toBe(200);
  });

  it("returns a JWKS with exactly one key and no private d param", async () => {
    const res = await req("GET", "/.well-known/jwks.json");
    const body = await res.json<{ keys: Record<string, unknown>[] }>();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("sets cache-control max-age", async () => {
    const res = await req("GET", "/.well-known/jwks.json");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });
});

describe("GET /.well-known/agent-card.json", () => {
  it("returns 200", async () => {
    const res = await req("GET", "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
  });

  it("returns a signed card with agent name and signatures array", async () => {
    const res = await req("GET", "/.well-known/agent-card.json");
    const body = await res.json<{
      name: string;
      signatures: unknown[];
    }>();
    expect(body.name).toBeTruthy();
    expect(Array.isArray(body.signatures)).toBe(true);
    expect(body.signatures.length).toBeGreaterThan(0);
  });
});

describe("POST /a2a", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await req("POST", "/a2a", {
      body: "{}",
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed Bearer token", async () => {
    const res = await req("POST", "/a2a", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not.a.real.jwt"
      }
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when jku origin is not in GATEWAY_ORIGINS", async () => {
    const token = await makeGatewayToken({ audience: AGENT_ORIGIN });
    const res = await req(
      "POST",
      "/a2a",
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        }
      },
      { ...env, GATEWAY_ORIGINS: "[]" }
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when the verified identity has no key (no DO to route to)", async () => {
    const res = await postRpc(
      {},
      { name: "NoKey", kind: "custom", workspaceId: 1 },
      TEST_ENV
    );
    expect(res.status).toBe(400);
  });

  it("accepts a message/send with a pushNotificationConfig: records a submitted Task and starts the handle workflow", async () => {
    const identity = {
      key: "custom:1:ada",
      name: "Ada",
      kind: "custom",
      workspaceId: 1
    };
    // Executor uses global env for routing; miniflare DO handles beginTask and
    // HANDLE_TASK_WORKFLOW.create. We assert on the observable HTTP contract only.
    const res = await postRpc(sendBody("Hello from test!"), identity);

    expect(res.status).toBe(200);
    const body = await res.json<{
      result: { kind: string; id: string; status: { state: string } };
    }>();
    // The accept ack is a *submitted Task*, not a Message.
    expect(body.result.kind).toBe("task");
    expect(body.result.status.state).toBe("submitted");
    expect(body.result.id.length).toBeGreaterThan(0);
  });

  it("rejects a message/send without a pushNotificationConfig (async-only)", async () => {
    const res = await postRpc(
      sendBody("hi", { push: false }),
      { key: "custom:1:ada" },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ error?: { code: number } }>();
    expect(body.error?.code).toBe(-32602);
  });

  it("rejects a message/send with a pushNotificationConfig missing the token", async () => {
    const res = await postRpc(
      sendBody("hi", { pushConfig: { url: PUSH_URL } }),
      { key: "custom:1:ada" },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      error?: { code: number; message: string };
    }>();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/token/);
  });

  it("rejects a message/send with a malformed pushNotificationConfig url", async () => {
    const res = await postRpc(
      sendBody("hi", { pushConfig: { url: "not-a-url", token: PUSH_TOKEN } }),
      { key: "custom:1:ada" },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      error?: { code: number; message: string };
    }>();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/not a valid URL/);
  });

  it("rejects a streaming method with an unsupported-operation JSON-RPC error", async () => {
    // The card advertises `streaming: false`, so the a2a-js handler rejects
    // `message/stream` up front with a JSON-RPC error (HTTP 200, code -32004).
    const res = await postRpc(
      sendBody("hi", { method: "message/stream" }),
      { key: "custom:1:ada" },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ error?: { code: number } }>();
    expect(body.error?.code).toBe(-32004);
  });

  it("tasks/cancel — publishes a canceled Task for a known taskId", async () => {
    const taskId = "task-cancel-test-1";
    const contextId = "ctx-cancel-1";
    const tasks = new Map<string, Task>([
      [taskId, buildSubmittedTask(taskId, contextId)]
    ]);
    const identity = {
      key: "custom:1:ada",
      name: "Ada",
      kind: "custom",
      workspaceId: 1
    };

    vi.spyOn(env.ReactiveAgent, "get").mockReturnValue({
      getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
      saveTask: vi.fn(async (task: Task) => {
        tasks.set(task.id, task);
      }),
      cancelTask: vi.fn(async (id: string) => {
        const task = tasks.get(id);
        if (!task) return null;
        const canceled = {
          ...task,
          status: {
            ...task.status,
            state: "canceled" as const,
            timestamp: new Date().toISOString()
          }
        };
        tasks.set(id, canceled);
        return canceled;
      })
    } as unknown as DurableObjectStub<ReactiveAgent>);

    const res = await postRpc(cancelBody(taskId), identity);

    expect(res.status).toBe(200);
    const body = await res.json<{
      result: { kind: string; id: string; status: { state: string } };
    }>();
    expect(body.result).toBeDefined();
    expect(body.result.kind).toBe("task");
    expect(body.result.id).toBe(taskId);
    // Cancel must flip the state to "canceled" — the notify workflow skips canceled tasks.
    expect(body.result.status.state).toBe("canceled");
  });

  it("tasks/cancel — returns taskNotFound error for an unknown taskId", async () => {
    const res = await postRpc(cancelBody("no-such-task"), {
      key: "custom:1:ada"
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      error?: { code: number; message: string };
    }>();
    // A2A error code -32001 = TaskNotFound
    expect(body.error?.code).toBe(-32001);
  });
});

describe("unknown routes", () => {
  it("returns 404 for GET /unknown", async () => {
    const res = await req("GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET /", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(404);
  });
});
