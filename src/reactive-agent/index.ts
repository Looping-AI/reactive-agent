import { Agent, type Schedule } from "agents";
import { env } from "cloudflare:workers";
import type { Task } from "@a2a-js/sdk";
import type { GatewayIdentity } from "@/a2a/verify";
import type { PlainTask } from "@/a2a/task";
import { parsePrivateJwk } from "@/a2a/card";
import {
  buildWorkingTask,
  postNotification,
  signCallbackJwt
} from "@/a2a/notify";
import { AgentDB } from "@/db/db";
import { createModelPair, embedTexts, type ModelPair } from "@/agent/model";
import { callerContext, soulPrompt } from "@/agent/prompt";
import { buildTools } from "@/agent/tools";
import { archiveMessages } from "@/agent/recall";
import { runTurn } from "@/agent/loop";
import { buildAgentSession, type SessionLike } from "@/agent/session";
import {
  COMPACT_AFTER_TOKENS,
  MEMORY_DESCRIPTION,
  MEMORY_MAX_TOKENS
} from "@/config";

/**
 * Everything the DO needs to stream **intermediate** `working` push notifications
 * live during a turn (see {@link file://../a2a/notify.ts}). Threaded in from the
 * {@link file://../workflows/handle-task.ts HandleTaskWorkflow}, which owns the
 * terminal `completed` callback; these are the progress messages before it.
 * RPC-serializable (crosses the workflow → DO boundary).
 */
export interface TurnPushContext {
  /** The accepted task id (echoed on every callback of this turn). */
  taskId: string;
  /** A2A context id, echoed on every callback. */
  contextId: string;
  /** Gateway push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gateway set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

/** Reply the DO returns when an unexpected (non-transient) failure aborts a turn. */
const UNEXPECTED_REPLY =
  "Sorry, I hit an unexpected error handling that request. Please try again, " +
  "and check the agent's logs if it keeps happening.";

/**
 * The agent runtime as a Durable Object: one instance per calling gateway-agent
 * (keyed by the verified JWT `identity.key`), each owning **one continuous
 * Session** — durable history + a self-edited `memory` block, backed by
 * `this.sql`. All of a caller's turns (any channel/thread) accumulate into this
 * single conversation.
 *
 * The outer Worker reaches this DO with a single native Cloudflare RPC call —
 * `stub.converse(text, identity)` — not HTTP: the DO is a private implementation
 * detail of the Worker, never exposed over the network, so it needs no internal
 * A2A/JSON-RPC layer of its own.
 *
 * History is compacted automatically once it grows past {@link COMPACT_AFTER_TOKENS}
 * (the Sessions `compactAfter` mechanism). (Phase 5 will also serve a self-generated
 * avatar from here.)
 */
export class ReactiveAgent extends Agent<Env> {
  private session?: SessionLike;
  private models?: ModelPair;
  private _db?: AgentDB;

  /** The agent's database (drizzle + migrations), built once per DO instance. */
  private get db(): AgentDB {
    return (this._db ??= new AgentDB(this.ctx.storage));
  }

  async onStart(): Promise<void> {
    // Await migrations before the SDK dispatches any RPC — eliminates the race
    // between schema creation and first query on cold start / hibernation wake-up.
    await this.db.ensureReady();
    // Register the weekly cleanup cron once per DO instance (idempotent guard).
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "cleanupOldTasks")) {
      await this.schedule("0 1 * * 0", "cleanupOldTasks", {});
    }
  }

  /** Cron handler: delete notify_tasks rows older than 30 days. Runs Sunday 01:00 UTC. */
  async cleanupOldTasks(
    _payload: Record<string, never>,
    _schedule: Schedule
  ): Promise<void> {
    this.db.tasks.cleanup();
  }

  private modelPair(): ModelPair {
    return (this.models ??= createModelPair());
  }

  /**
   * The one continuous Session for this caller (rebuilt from `this.sql` after
   * eviction). Takes the verified identity so compaction can archive the
   * displaced messages into this instance's Vectorize namespace (episodic
   * recall). Memoized — `identity` is constant for the DO's life (the DO is
   * keyed 1:1 by `identity.key`).
   */
  getSession(identity: GatewayIdentity): SessionLike {
    const namespace = recallNamespace(identity);
    return (this.session ??= buildAgentSession(
      this,
      this.modelPair().primary(),
      {
        soul: () => soulPrompt(),
        memoryDescription: MEMORY_DESCRIPTION,
        memoryMaxTokens: MEMORY_MAX_TOKENS,
        compactAfterTokens: COMPACT_AFTER_TOKENS,
        // Episodic recall: embed the messages each compaction displaces into
        // this instance's Vectorize namespace. Best-effort — the wrapper
        // swallows failures so compaction still shortens history.
        onArchive: (messages) =>
          archiveMessages(this.env.VECTORIZE, namespace, messages, embedTexts)
      }
    ));
  }

  /**
   * Answer one turn for this caller and return the reply text. Runs the
   * Workers-AI tool loop over the continuous Session (append → generate →
   * persist).
   *
   * The turn loop {@link runTurn} never throws — transient/unexpected failures
   * resolve to a friendly reply — so this method rejects only on a genuine
   * RPC/transport fault, keeping the Worker-side caller trivial.
   *
   * When `push` is supplied, intermediate assistant content (text emitted on a
   * step that also makes tool calls) is streamed live to the gateway as `working`
   * callbacks — best-effort, so a failed progress post never fails the turn. The
   * returned string is the terminal reply, delivered separately as the durable
   * `completed` callback by the workflow.
   */
  async converse(
    text: string,
    identity: GatewayIdentity,
    push?: TurnPushContext
  ): Promise<string> {
    const session = this.getSession(identity);
    // Gate the `recall` tool on "has compacted at least once" — nothing is
    // archived (and the tool would only return empties) before the first
    // compaction.
    const hasArchive = (await session.getCompactions()).length > 0;
    return await runTurn({
      session,
      text,
      systemSuffix: callerContext(identity),
      tools: buildTools(
        {
          index: this.env.VECTORIZE,
          namespace: recallNamespace(identity),
          embed: embedTexts,
          hasArchive
        },
        this.env.BROWSER
      ),
      models: this.modelPair(),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: push ? this.streamWorking(push) : undefined
    });
  }

  /**
   * Build the intermediate-content sink for a turn: sign the callback JWT once
   * (lazily, reused across every progress message; 5m TTL), then POST each content
   * message as a `working` Task snapshot. Best-effort — every failure is logged
   * and swallowed so streaming never aborts generation or the turn. `messageId`
   * is `${taskId}:${stepIndex}` so a re-run dedupes on the gateway.
   */
  private streamWorking(
    push: TurnPushContext
  ): (text: string, stepIndex: number) => Promise<void> {
    let jwt: string | undefined;
    return async (text: string, stepIndex: number) => {
      try {
        jwt ??= await signCallbackJwt(
          parsePrivateJwk(this.env.A2A_SIGNING_KEY),
          {
            jku: push.jku,
            aud: push.pushUrl
          }
        );
        const task = buildWorkingTask(
          push.taskId,
          push.contextId,
          text,
          stepIndex
        );
        const res = await postNotification(
          push.pushUrl,
          push.pushToken,
          jwt,
          task
        );
        if (!res.ok) {
          console.warn("[reactive-agent] working notification non-2xx", {
            taskId: push.taskId,
            stepIndex,
            status: res.status
          });
        }
      } catch (err) {
        console.warn("[reactive-agent] working notification failed", {
          taskId: push.taskId,
          stepIndex,
          err: String(err)
        });
      }
    };
  }

  // --- Async task state (accept + notify) ---------------------------------
  //
  // Thin RPC surface delegating to AgentDB's `tasks` table (src/db/db.ts).
  // Native RPC methods — the DO is never a network-reachable server. The
  // workflow, which cannot touch this SQLite directly, calls these via DO RPC.
  //
  // The Task-returning methods return {@link PlainTask} (the SDK `Task` minus its
  // `unknown`-bearing extension `metadata`); returning the raw SDK `Task` would
  // collapse the generated DO-stub types to `never`. See {@link file://../a2a/task.ts}.

  async beginTask(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): Promise<PlainTask> {
    return this.db.tasks.begin(input);
  }

  async getTask(taskId: string): Promise<PlainTask | null> {
    return this.db.tasks.get(taskId);
  }

  async saveTask(task: Task): Promise<void> {
    this.db.tasks.save(task);
  }

  async markWorking(taskId: string): Promise<void> {
    this.db.tasks.markWorking(taskId);
  }

  async completeTask(task: Task): Promise<void> {
    this.db.tasks.complete(task);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    return this.db.tasks.cancel(taskId);
  }
}

/**
 * Resolve the per-caller agent DO stub, keyed by the verified `identity.key`. Pure
 * routing — the DO's methods are honestly typed now that its `Task` returns are
 * {@link PlainTask}, so callers reach the agent directly with no cast.
 */
export function getAgent(
  identity: GatewayIdentity
): DurableObjectStub<ReactiveAgent> {
  if (!identity.key) {
    throw new Error("identity.key is required to route to the agent DO");
  }
  return env.ReactiveAgent.get(env.ReactiveAgent.idFromName(identity.key));
}

/**
 * The Vectorize namespace isolating this instance's episodic archive. Bound in
 * code from the verified `identity.key` (e.g. `custom:7:analytics`) — never from
 * model input — so one caller can never read another's history. The DO is keyed
 * 1:1 by this same key, and the executor refuses a token without it (400), so it
 * is always present here.
 */
function recallNamespace(identity: GatewayIdentity): string {
  if (!identity.key) {
    throw new Error("identity.key is required for namespace isolation");
  }
  return identity.key;
}
