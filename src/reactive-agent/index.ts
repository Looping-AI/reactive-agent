import { Agent, type Schedule } from "agents";
import { env } from "cloudflare:workers";
import type { ToolSet } from "ai";
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
import { runDecompose } from "@/agent/decompose";
import { runCompose } from "@/agent/compose";
import { decomposeReplyMessageId, sessionText } from "@/agent/history";
import { buildAgentSession, type SessionLike } from "@/agent/session";
import { resolveRecipeForType, validateRecipe } from "@/agent/subtasks/recipe";
import type {
  ComposeTaskResult,
  CompositionBranch,
  DecomposeTaskResult,
  DependencyResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  Subtask,
  SubtaskId,
  SubtaskStatus
} from "@/agent/subtasks/types";
import { FINGERPRINT_MISMATCH, RecipeSubagent, subagentName } from "@/subagent";
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
 * Stand-in acknowledgement for the unreachable case where a Task's Subtasks are
 * durable but its decomposition reply is not in the Session (the reply is always
 * appended first). Neutral by design: the work is valid and running, so the user
 * gets an honest acknowledgement rather than a failed Task.
 */
const RECOVERED_REPLY = "Working on your request.";

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

  /**
   * Test-only model injection. A **field**, not a constructor argument or RPC
   * parameter, so it never appears on the generated DO stub: production callers
   * cannot reach it, and no model configuration crosses the RPC boundary. Mirrors
   * `RecipeSubagent.modelsOverride`.
   */
  modelsOverride?: ModelPair;

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

  /**
   * Cron handler: delete notify_tasks and their Subtasks older than 30 days.
   * Both are keyed on their own `created_at` (written in the same Task
   * lifecycle), so a parent Task and its Subtasks age out together. Runs
   * Sunday 01:00 UTC.
   */
  async cleanupOldTasks(
    _payload: Record<string, never>,
    _schedule: Schedule
  ): Promise<void> {
    this.db.tasks.cleanup();
    this.db.subtasks.cleanup();
  }

  private modelPair(): ModelPair {
    return this.modelsOverride ?? (this.models ??= createModelPair());
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
   * The main agent's gated tool set for this caller. The `recall` tool is gated on
   * "has compacted at least once" — nothing is archived (and the tool would only
   * return empties) before the first compaction.
   */
  private async mainAgentTools(
    session: SessionLike,
    identity: GatewayIdentity
  ): Promise<ToolSet> {
    const hasArchive = (await session.getCompactions()).length > 0;
    return buildTools(
      {
        index: this.env.VECTORIZE,
        namespace: recallNamespace(identity),
        embed: embedTexts,
        hasArchive
      },
      this.env.BROWSER
    );
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
    return await runTurn({
      session,
      text,
      systemSuffix: callerContext(identity),
      tools: await this.mainAgentTools(session, identity),
      models: this.modelPair(),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: push ? this.streamWorking(push) : undefined
    });
  }

  /**
   * POST one `working` Task snapshot to the gateway callback, keyed by a stable
   * semantic `key` (`step:<n>` for tool-loop content, `decompose` for the Phase 1
   * reply — see {@link buildWorkingTask}). Best-effort: every failure is logged
   * and swallowed, so a progress post never aborts generation or fails a phase.
   *
   * The JWT is signed per call (5m TTL). {@link streamWorking} caches one across a
   * turn's steps; one-shot milestone callers sign once anyway.
   */
  private async postWorking(
    push: TurnPushContext,
    text: string,
    key: string,
    signedJwt?: string
  ): Promise<void> {
    try {
      const jwt =
        signedJwt ??
        (await signCallbackJwt(parsePrivateJwk(this.env.A2A_SIGNING_KEY), {
          jku: push.jku,
          aud: push.pushUrl
        }));
      const task = buildWorkingTask(push.taskId, push.contextId, text, key);
      const res = await postNotification(
        push.pushUrl,
        push.pushToken,
        jwt,
        task
      );
      if (!res.ok) {
        console.warn("[reactive-agent] working notification non-2xx", {
          taskId: push.taskId,
          key,
          status: res.status
        });
      }
    } catch (err) {
      console.warn("[reactive-agent] working notification failed", {
        taskId: push.taskId,
        key,
        err: String(err)
      });
    }
  }

  /**
   * Build the intermediate-content sink for a turn: sign the callback JWT once
   * (lazily, reused across every progress message; 5m TTL), then POST each content
   * message as a `working` Task snapshot via {@link postWorking}. `messageId` is
   * `${taskId}:step:${stepIndex}` so a re-run dedupes on the gateway and cannot
   * collide with milestone keys (`decompose`, `final`).
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
      } catch (err) {
        console.warn("[reactive-agent] callback signing failed", {
          taskId: push.taskId,
          err: String(err)
        });
        return;
      }
      await this.postWorking(push, text, `step:${stepIndex}`, jwt);
    };
  }

  // --- Phased task pipeline (decompose → execute → compose) ----------------
  //
  // The parent-owned half of the five-phase Task flow. The Workflow drives these
  // over DO RPC (it cannot touch this SQLite or this Session directly); each is a
  // durable step, so every method here is safe to call again after a crash —
  // decomposition is idempotent on the Task, execution recovers from either the
  // parent row or the child's cached result, and composition recovers from the
  // Session.

  /**
   * Phase 1: decompose one accepted Task into a durable 1..8-node Subtask DAG and
   * return the first user-visible reply.
   *
   * Idempotent: a re-run finds the persisted Subtasks and recovers the original
   * reply from the Session, with no inference and no duplicate rows. When `push`
   * is supplied the reply is also emitted as a `working` callback keyed
   * `decompose` — deterministic, so a re-post dedupes at the gateway.
   *
   * Returns a typed `failed` result when both models produce unusable output (the
   * Workflow routes it to failed delivery); throws only on a transient fault, for
   * the step to retry.
   */
  async decomposeTask(input: {
    taskId: string;
    text: string;
    identity: GatewayIdentity;
    push?: TurnPushContext;
  }): Promise<DecomposeTaskResult> {
    const { taskId, text, identity, push } = input;
    const session = this.getSession(identity);

    // Recovery: the decomposition is already durable. Never re-infer — the reply
    // may already be in front of the user.
    const existing = this.db.subtasks.list(taskId);
    if (existing.length > 0) {
      const stored = await session.getMessage(decomposeReplyMessageId(taskId));
      const reply = stored ? sessionText(stored) : RECOVERED_REPLY;
      if (!stored) {
        // Unreachable: the reply is appended before the rows are persisted. Warn
        // and deliver a neutral acknowledgement rather than poisoning a Task
        // whose subtasks are valid and ready to run.
        console.warn(
          "[reactive-agent] decomposition reply missing on recovery",
          {
            taskId
          }
        );
      }
      if (push) await this.postWorking(push, reply, "decompose");
      return { status: "completed", reply, subtasks: existing };
    }

    const outcome = await runDecompose({
      session,
      taskId,
      text,
      systemSuffix: callerContext(identity),
      tools: await this.mainAgentTools(session, identity),
      models: this.modelPair(),
      onContent: push ? this.streamWorking(push) : undefined
    });
    if (outcome.status === "failed") return outcome;

    // The reply is durable in the Session before the rows exist. A crash in this
    // window re-runs decomposition and persists the *retry's* drafts under the
    // *first* attempt's reply — both are valid outputs of the same input, and no
    // invariant breaks. The reverse order could strand persisted subtasks with no
    // recoverable reply.
    const subtasks = this.db.subtasks.createDecomposition(
      taskId,
      outcome.drafts
    );
    if (push) await this.postWorking(push, outcome.reply, "decompose");
    return { status: "completed", reply: outcome.reply, subtasks };
  }

  /** A Task's Subtasks in stable ordinal order (the scheduler's view of the DAG). */
  async listSubtasks(taskId: string): Promise<Subtask[]> {
    return this.db.subtasks.list(taskId);
  }

  /**
   * Skip every pending Subtask blocked by a dependency that did not succeed, and
   * return the refreshed DAG.
   *
   * Runs to a fixpoint because skipping propagates: a node skipped for a failed
   * prerequisite blocks *its* dependents in turn. Bounded by the 8-Subtask
   * maximum. Independent branches are untouched — one branch's failure never
   * stops work that does not depend on it.
   */
  async skipBlockedSubtasks(taskId: string): Promise<Subtask[]> {
    const blocked = new Set<SubtaskStatus>(["failed", "skipped", "canceled"]);
    for (;;) {
      const current = this.db.subtasks.list(taskId);
      const byId = new Map(current.map((s) => [s.id, s]));
      const next = current.filter(
        (s) =>
          s.status === "pending" &&
          s.dependsOn.some((dep) => {
            const parent = byId.get(dep);
            return parent !== undefined && blocked.has(parent.status);
          })
      );
      if (next.length === 0) return current;
      for (const s of next) this.db.subtasks.skip(s.id);
    }
  }

  /** Parent cancellation: cancel every still-pending Subtask. Returns the count. */
  async cancelPendingSubtasks(taskId: string): Promise<number> {
    return this.db.subtasks.cancelPending(taskId);
  }

  /**
   * Phase 2: execute one Subtask in an isolated, managed subagent and durably
   * record its terminal outcome in the parent.
   *
   * The parent owns the child's whole lifecycle. The ordering rules that make this
   * safe to re-run:
   *
   * - A terminal row short-circuits: the result is already durable.
   * - A **fresh** execution deletes any stale child first, so the new request can
   *   never collide with a previous one's cached fingerprint.
   * - An **ambiguous retry** (the row is already `running` — a previous attempt
   *   crashed) must *not* delete the child: it may hold the cached terminal result
   *   that makes the retry free.
   * - The child is deleted **only after** its result is durably copied here.
   *
   * Throws on a transient fault (the step retries) and on scheduler-invariant
   * violations (an unknown Subtask, or a dependency that has not completed) — both
   * are bugs, not outcomes.
   */
  async executeSubtask(id: SubtaskId): Promise<Subtask> {
    const subtask = this.db.subtasks.get(id);
    if (!subtask) throw new Error(`unknown subtask: ${id}`);

    const name = subagentName(subtask.taskId, id);

    if (subtask.status !== "pending" && subtask.status !== "running") {
      // Already terminal. Sweep the child in case a previous run persisted the
      // result and crashed before deleting it.
      await this.deleteChildQuietly(name);
      return subtask;
    }

    if (await this.isTaskCanceled(subtask.taskId)) {
      // Start no new work. A row left `running` by a previous attempt that
      // crashed is resolved here rather than left to lie about its state until
      // cleanup — `cancelPending` only reaches pending rows, so nothing else
      // would ever transition it.
      if (subtask.status === "running") {
        this.db.subtasks.cancelRunning(id);
        await this.deleteChildQuietly(name);
        return this.requireSubtask(id);
      }
      return subtask;
    }

    const dependencyResults = this.loadDependencyResults(subtask);
    const recipe = resolveRecipeForType(subtask.type);

    let validated;
    try {
      validated = validateRecipe(recipe);
    } catch (err) {
      // A disabled Recipe is a configuration bug, not a transient fault. Record it
      // as a branch failure so the DAG's skip semantics apply to its dependents.
      const message = `recipe ${recipe.key} unusable: ${String(err)}`;
      this.db.subtasks.start(id, {
        recipeId: recipe.key,
        recipeVersion: recipe.version
      });
      this.db.subtasks.fail(id, message);
      return this.requireSubtask(id);
    }

    // Record the resolved Recipe at execution start, and claim the row. Winning
    // this transition is exactly what distinguishes a fresh execution from a
    // retry — the difference that decides whether the child may be deleted.
    const claimed = this.db.subtasks.start(id, {
      recipeId: validated.key,
      recipeVersion: validated.version
    });

    if (claimed) {
      await this.deleteChildQuietly(name);
    } else {
      const current = this.requireSubtask(id);
      if (current.status !== "running") {
        await this.deleteChildQuietly(name);
        return current;
      }
      // Ambiguous retry: leave the child alone; its cache may replay the result.
    }

    const request: RecipeExecutionRequest = {
      taskId: subtask.taskId,
      subtaskId: id,
      recipe: validated,
      prompt: subtask.prompt,
      references: subtask.references,
      dependencyResults
    };

    const result = await this.executeInChild(name, request);

    // The Task may have been canceled while the child ran. The result is late:
    // discard it, and leave the row in a truthful terminal state.
    if (await this.isTaskCanceled(subtask.taskId)) {
      this.db.subtasks.cancelRunning(id);
      await this.deleteChildQuietly(name);
      return this.requireSubtask(id);
    }

    const persisted = this.persistResult(id, result);
    if (!persisted) {
      // Lost a race with a concurrent invocation, or the row moved on.
      const current = this.requireSubtask(id);
      if (current.status === "pending" || current.status === "running") {
        throw new Error(
          `subtask ${id} could not record its result (status=${current.status})`
        );
      }
      await this.deleteChildQuietly(name);
      return current;
    }

    // Only now is the result durable in the parent — the child is free to go. A
    // failure here propagates: the retry hits the terminal-row path above, which
    // sweeps the child best-effort.
    await this.deleteSubAgent(RecipeSubagent, name);
    return this.requireSubtask(id);
  }

  /**
   * Invoke the managed child, recreating it once on a fingerprint mismatch.
   *
   * A mismatch means a stale child survived from a *different* request under this
   * name — recoverable exactly once by deleting it and starting clean. A second
   * mismatch is a genuine lifecycle bug and must surface.
   */
  private async executeInChild(
    name: string,
    request: RecipeExecutionRequest
  ): Promise<RecipeExecutionResult> {
    const child = await this.subAgent(RecipeSubagent, name);
    try {
      return await child.execute(request);
    } catch (err) {
      if (!String(err).includes(FINGERPRINT_MISMATCH)) throw err;
      console.warn("[reactive-agent] stale subagent state, recreating", {
        name
      });
      await this.deleteSubAgent(RecipeSubagent, name);
      const fresh = await this.subAgent(RecipeSubagent, name);
      return await fresh.execute(request);
    }
  }

  /** Persist a child's terminal outcome. Returns whether the guarded write applied. */
  private persistResult(id: SubtaskId, result: RecipeExecutionResult): boolean {
    if (result.status === "failed") {
      return this.db.subtasks.fail(id, result.error);
    }
    try {
      return this.db.subtasks.complete(id, result.resultParts);
    } catch (err) {
      // A "completed" result with no usable text breaks the child's contract.
      // Record it as a failure — retrying would only replay the same bad result
      // from the child's cache forever.
      console.warn("[reactive-agent] malformed completed result", {
        subtaskId: id,
        err: String(err)
      });
      return this.db.subtasks.fail(id, `malformed result: ${String(err)}`);
    }
  }

  /**
   * Load a Subtask's dependency results, in ordinal order.
   *
   * Order is semantic: it feeds the child's request fingerprint, so a retry must
   * build the identical array or the cache misses. A dependency that has not
   * completed means the scheduler ran this node too early.
   */
  private loadDependencyResults(subtask: Subtask): DependencyResult[] {
    if (subtask.dependsOn.length === 0) return [];
    const deps = this.db.subtasks
      .list(subtask.taskId)
      .filter((s) => subtask.dependsOn.includes(s.id));
    if (deps.length !== subtask.dependsOn.length) {
      throw new Error(`subtask ${subtask.id} has unknown dependencies`);
    }
    return deps.map((dep) => {
      if (dep.status !== "completed" || !dep.resultParts) {
        throw new Error(
          `subtask ${subtask.id} ran before dependency ${dep.id} completed ` +
            `(status=${dep.status})`
        );
      }
      return {
        subtaskId: dep.id,
        type: dep.type,
        resultParts: dep.resultParts
      };
    });
  }

  /** Re-read a Subtask that must exist (it was just written). */
  private requireSubtask(id: SubtaskId): Subtask {
    const row = this.db.subtasks.get(id);
    if (!row) throw new Error(`subtask ${id} disappeared`);
    return row;
  }

  /** Delete a managed child, swallowing failures (used on best-effort sweeps). */
  private async deleteChildQuietly(name: string): Promise<void> {
    try {
      await this.deleteSubAgent(RecipeSubagent, name);
    } catch (err) {
      console.warn("[reactive-agent] subagent cleanup failed", {
        name,
        err: String(err)
      });
    }
  }

  /** Whether the parent Task has been canceled (checked before and after work). */
  private async isTaskCanceled(taskId: string): Promise<boolean> {
    return this.db.tasks.get(taskId)?.status.state === "canceled";
  }

  /**
   * Phase 3: compose the executed DAG's outcomes into the terminal reply and
   * persist it to the Session.
   *
   * Skips inference where it adds nothing: a single-Subtask Task returns its
   * result directly, and a Task with no successful branch fails without composing.
   * Idempotent — a re-run returns the durable reply from the Session.
   */
  async composeTask(input: {
    taskId: string;
    identity: GatewayIdentity;
  }): Promise<ComposeTaskResult> {
    const { taskId, identity } = input;
    const branches: CompositionBranch[] = this.db.subtasks
      .list(taskId)
      .map((s) => ({
        subtaskId: s.id,
        ordinal: s.ordinal,
        type: s.type,
        status: s.status,
        resultParts: s.resultParts,
        error: s.error
      }));
    if (branches.length === 0) {
      return { status: "failed", error: `task ${taskId} has no subtasks` };
    }
    return await runCompose({
      session: this.getSession(identity),
      taskId,
      systemSuffix: callerContext(identity),
      models: this.modelPair(),
      branches
    });
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
