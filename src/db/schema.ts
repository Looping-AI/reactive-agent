import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

/**
 * Durable state for async A2A tasks (accept + notify lifecycle).
 *
 * One row per task: written by the Worker's accept path (`beginTask`, keyed by
 * `message_id` for gateway-dedup) and mutated by the `HandleTaskWorkflow` via
 * DO RPC (`markWorking`, `saveTask`, `cancelTask`). `tasks/get` reads it
 * via `DurableTaskStore`. Table lives in the caller's DO SQLite (`this.ctx.storage`).
 */
export const notifyTasks = sqliteTable(
  "notify_tasks",
  {
    taskId: text("task_id").primaryKey(),
    /** Gateway-assigned dedupe key — null for tasks created outside `beginTask`. */
    messageId: text("message_id").unique(),
    state: text("state").notNull(),
    taskJson: text("task_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [index("idx_notify_tasks_created_at").on(table.createdAt)]
);

/**
 * Durable Subtasks: the 1–8 units a parent A2A Task is decomposed into.
 *
 * One row per Subtask, owned by the caller's `ReactiveAgent` DO SQLite. The
 * integer primary key assigns a caller-local, monotonically increasing
 * {@link file://../agent/subtasks/types.ts SubtaskId} (autoincrement, so ids are
 * never reused after cleanup deletes rows). References, dependency edges, and
 * result parts are stored as JSON text and parsed back into the `Subtask`
 * contract by `src/db/models/subtasks.ts`. `recipe_id`/`recipe_version` are null
 * until execution starts, then record the resolved Recipe after-the-fact.
 */
export const subtasks = sqliteTable(
  "subtasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    /** Main-agent round that delegated this Subtask (0-based). */
    round: integer("round").notNull(),
    /** Position within the parent Task, increasing across every round. */
    ordinal: integer("ordinal").notNull(),
    type: text("type").notNull(),
    /** Resolved Recipe key, written only at execution start. */
    recipeId: text("recipe_id"),
    /** Resolved Recipe version, written only at execution start. */
    recipeVersion: integer("recipe_version"),
    prompt: text("prompt").notNull(),
    /** JSON `SubtaskReference[]` — verbatim role+text snapshots from decomposition. */
    referencesJson: text("references_json").notNull(),
    /** JSON `SubtaskId[]` — resolved dependency edges. */
    dependsOnJson: text("depends_on_json").notNull(),
    /** JSON `SubtaskParams` — the type's required inputs, validated at delegation. */
    paramsJson: text("params_json").notNull().default("{}"),
    status: text("status").notNull(),
    /** JSON `SubtaskResultPart[]` — text-only terminal output; null until complete. */
    resultPartsJson: text("result_parts_json"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at")
  },
  (table) => [
    uniqueIndex("idx_subtasks_task_ordinal").on(table.taskId, table.ordinal),
    index("idx_subtasks_task_round").on(table.taskId, table.round),
    index("idx_subtasks_status").on(table.status),
    index("idx_subtasks_created_at").on(table.createdAt)
  ]
);

/**
 * ARC-AGI-3 scorecards the main agent has opened.
 *
 * The API has no endpoint that lists scorecards, so this table *is* the list —
 * `arc_list_scorecards` is a pure read of it. One row per `card_id`, inserted by
 * `arc_open_scorecard` and closed by `arc_close_scorecard`, which persists the
 * terminal aggregate as `summary_json`.
 *
 * Rows are **never deleted** (no `cleanup()`, unlike {@link notifyTasks} and
 * {@link subtasks}): a closed card cannot be re-read from the API, so the stored
 * summary is the only lasting record of a score.
 *
 * Nothing here binds a card to a Subtask. A scorecard is not owned by one unit of
 * work — the main agent may hand the same card to several plays — so the card a
 * subagent uses travels in its prompt, not in a column.
 */
export const scorecards = sqliteTable(
  "scorecards",
  {
    /** The ARC-assigned card id (a uuid). */
    cardId: text("card_id").primaryKey(),
    status: text("status").notNull().default("open"),
    /**
     * JSON cookie jar from `POST /api/scorecard/open`. The ARC API pins a card to
     * the session that opened it: without these cookies the card is invisible —
     * RESET reports the game as not found and close 404s — so the jar is part of
     * the card's identity, not an optimization.
     */
    cookiesJson: text("cookies_json").notNull().default("{}"),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    /** JSON `ScorecardSummary` from `POST /api/scorecard/close`; null until closed. */
    summaryJson: text("summary_json")
  },
  (table) => [index("idx_scorecards_opened_at").on(table.openedAt)]
);
