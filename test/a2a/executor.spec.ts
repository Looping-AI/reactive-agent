import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { RequestContext } from "@a2a-js/sdk/server";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type { ReactiveAgent } from "@/reactive-agent";
import { A2AExecutor } from "@/a2a/executor";
import type { HandleTaskParams } from "@/workflows/handle-task";

const identity = { key: "custom:1:ada", name: "Ada", kind: "custom" };

function requestContext(parts: unknown[]): RequestContext {
  return {
    taskId: "task-1",
    contextId: "context-1",
    userMessage: {
      messageId: "message-1",
      role: "user",
      kind: "message",
      parts
    }
  } as unknown as RequestContext;
}

afterEach(() => vi.restoreAllMocks());

describe("A2AExecutor", () => {
  it("passes metadata-free structured parts to the Workflow payload", async () => {
    vi.spyOn(env.ReactiveAgent, "get").mockReturnValue({
      beginTask: vi.fn(async () => ({ id: "task-1" }))
    } as unknown as DurableObjectStub<ReactiveAgent>);
    const create = vi
      .spyOn(env.HANDLE_TASK_WORKFLOW, "create")
      .mockResolvedValue({} as never);
    const publish = vi.fn();
    const finished = vi.fn();
    const executor = new A2AExecutor(identity, {
      pushConfig: {
        url: "https://gateway.example.test/a2a/notifications",
        token: "push-token"
      },
      jku: "https://agent.example.test/.well-known/jwks.json"
    });

    await executor.execute(
      requestContext([
        { kind: "text", text: "hello", metadata: { ignored: true } },
        {
          kind: "data",
          data: { nested: [1, true] },
          metadata: { ignored: true }
        }
      ]),
      { publish, finished } as unknown as ExecutionEventBus
    );

    expect(create).toHaveBeenCalledWith({
      id: "handle-message-1",
      params: expect.objectContaining<Partial<HandleTaskParams>>({
        taskId: "task-1",
        text: "hello",
        parts: [
          { kind: "text", text: "hello" },
          { kind: "data", data: { nested: [1, true] } }
        ]
      })
    });
    expect(publish).toHaveBeenCalledWith({ id: "task-1" });
    expect(finished).toHaveBeenCalledOnce();
  });

  it("rejects a message with no usable parts before creating a task", async () => {
    const get = vi.spyOn(env.ReactiveAgent, "get");
    const create = vi.spyOn(env.HANDLE_TASK_WORKFLOW, "create");
    const executor = new A2AExecutor(identity, {
      pushConfig: {
        url: "https://gateway.example.test/a2a/notifications",
        token: "push-token"
      },
      jku: "https://agent.example.test/.well-known/jwks.json"
    });

    await expect(
      executor.execute(requestContext([{ kind: "text", text: "  " }]), {
        publish: vi.fn(),
        finished: vi.fn()
      } as unknown as ExecutionEventBus)
    ).rejects.toThrow(/no usable parts/);

    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
