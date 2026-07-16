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

function executor(): A2AExecutor {
  return new A2AExecutor(identity, {
    pushConfig: {
      url: "https://gateway.example.test/a2a/notifications",
      token: "push-token"
    },
    jku: "https://agent.example.test/.well-known/jwks.json"
  });
}

afterEach(() => vi.restoreAllMocks());

describe("A2AExecutor", () => {
  it("passes the user-turn text to the Workflow payload", async () => {
    vi.spyOn(env.ReactiveAgent, "get").mockReturnValue({
      beginTask: vi.fn(async () => ({ id: "task-1" }))
    } as unknown as DurableObjectStub<ReactiveAgent>);
    const create = vi
      .spyOn(env.HANDLE_TASK_WORKFLOW, "create")
      .mockResolvedValue({} as never);
    const publish = vi.fn();
    const finished = vi.fn();

    await executor().execute(
      requestContext([
        { kind: "text", text: "hello", metadata: { ignored: true } }
      ]),
      { publish, finished } as unknown as ExecutionEventBus
    );

    expect(create).toHaveBeenCalledWith({
      id: "handle-message-1",
      params: expect.objectContaining<Partial<HandleTaskParams>>({
        taskId: "task-1",
        text: "hello"
      })
    });
    expect(publish).toHaveBeenCalledWith({ id: "task-1" });
    expect(finished).toHaveBeenCalledOnce();
  });

  it("swallows the duplicate-instance retry race and still acks the task", async () => {
    vi.spyOn(env.ReactiveAgent, "get").mockReturnValue({
      beginTask: vi.fn(async () => ({ id: "task-1" }))
    } as unknown as DurableObjectStub<ReactiveAgent>);
    vi.spyOn(env.HANDLE_TASK_WORKFLOW, "create").mockRejectedValue(
      new Error(
        "(instance.already_exists) An instance with that id already exists"
      )
    );
    const publish = vi.fn();
    const finished = vi.fn();

    await expect(
      executor().execute(requestContext([{ kind: "text", text: "hello" }]), {
        publish,
        finished
      } as unknown as ExecutionEventBus)
    ).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledWith({ id: "task-1" });
    expect(finished).toHaveBeenCalledOnce();
  });

  // A missing/misconfigured binding must not read as an accepted turn: swallowing
  // it would strand the task in `submitted` with no workflow to complete it.
  it("rethrows a create failure that merely mentions existence", async () => {
    vi.spyOn(env.ReactiveAgent, "get").mockReturnValue({
      beginTask: vi.fn(async () => ({ id: "task-1" }))
    } as unknown as DurableObjectStub<ReactiveAgent>);
    vi.spyOn(env.HANDLE_TASK_WORKFLOW, "create").mockRejectedValue(
      new Error("(instance.not_found) Instance does not exist")
    );
    const publish = vi.fn();

    await expect(
      executor().execute(requestContext([{ kind: "text", text: "hello" }]), {
        publish,
        finished: vi.fn()
      } as unknown as ExecutionEventBus)
    ).rejects.toThrow(/does not exist/);

    expect(publish).not.toHaveBeenCalled();
  });

  it("rethrows a non-Error create failure", async () => {
    vi.spyOn(env.ReactiveAgent, "get").mockReturnValue({
      beginTask: vi.fn(async () => ({ id: "task-1" }))
    } as unknown as DurableObjectStub<ReactiveAgent>);
    vi.spyOn(env.HANDLE_TASK_WORKFLOW, "create").mockRejectedValue(
      "workflows unavailable"
    );

    await expect(
      executor().execute(requestContext([{ kind: "text", text: "hello" }]), {
        publish: vi.fn(),
        finished: vi.fn()
      } as unknown as ExecutionEventBus)
    ).rejects.toBe("workflows unavailable");
  });

  it("rejects a message with no usable text before creating a task", async () => {
    const get = vi.spyOn(env.ReactiveAgent, "get");
    const create = vi.spyOn(env.HANDLE_TASK_WORKFLOW, "create");

    await expect(
      executor().execute(requestContext([{ kind: "text", text: "  " }]), {
        publish: vi.fn(),
        finished: vi.fn()
      } as unknown as ExecutionEventBus)
    ).rejects.toThrow(/no usable text/);

    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
