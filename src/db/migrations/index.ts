/**
 * Drizzle migrations bundled inline for Cloudflare Workers compatibility.
 * Workers have no filesystem at runtime, so migration data is inlined here.
 * Generated from src/db/schema.ts via `npx drizzle-kit generate`.
 *
 * Key format: "m{zero-padded idx}" (e.g. "m0000") — this is what Drizzle's
 * durable-sqlite migrator reads from `config.migrations[key]`.
 *
 * To add a migration:
 *   1. Run `npx drizzle-kit generate`
 *   2. Copy the new .sql content here as "m000N"
 *   3. Append an entry to journal.entries with the idx/when/tag/breakpoints
 *      from src/db/migrations/meta/_journal.json
 */
import type { migrate } from "drizzle-orm/durable-sqlite/migrator";

type MigrationConfig = Parameters<typeof migrate>[1];

const dbMigrations: MigrationConfig = {
  journal: {
    entries: [
      {
        idx: 0,
        when: 1783508206066,
        tag: "0000_goofy_squadron_supreme",
        breakpoints: true
      },
      {
        idx: 1,
        when: 1784128150521,
        tag: "0001_great_goliath",
        breakpoints: true
      },
      {
        idx: 2,
        when: 1784631097834,
        tag: "0002_add_subtask_round",
        breakpoints: true
      }
    ]
  },
  migrations: {
    m0000: `CREATE TABLE \`notify_tasks\` (
\t\`task_id\` text PRIMARY KEY NOT NULL,
\t\`message_id\` text,
\t\`state\` text NOT NULL,
\t\`task_json\` text NOT NULL,
\t\`created_at\` integer NOT NULL,
\t\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`notify_tasks_message_id_unique\` ON \`notify_tasks\` (\`message_id\`);
--> statement-breakpoint
CREATE INDEX \`idx_notify_tasks_created_at\` ON \`notify_tasks\` (\`created_at\`);`,
    m0001: `CREATE TABLE \`subtasks\` (
\t\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
\t\`task_id\` text NOT NULL,
\t\`ordinal\` integer NOT NULL,
\t\`type\` text NOT NULL,
\t\`recipe_id\` text,
\t\`recipe_version\` integer,
\t\`prompt\` text NOT NULL,
\t\`references_json\` text NOT NULL,
\t\`depends_on_json\` text NOT NULL,
\t\`status\` text NOT NULL,
\t\`result_parts_json\` text,
\t\`error\` text,
\t\`created_at\` integer NOT NULL,
\t\`updated_at\` integer NOT NULL,
\t\`completed_at\` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`idx_subtasks_task_ordinal\` ON \`subtasks\` (\`task_id\`,\`ordinal\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_status\` ON \`subtasks\` (\`status\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_created_at\` ON \`subtasks\` (\`created_at\`);`,
    // `round` is required with no default, so SQLite cannot ADD COLUMN it —
    // the table is rebuilt and pre-existing rows are backfilled with round 0.
    m0002: `CREATE TABLE \`__new_subtasks\` (
\t\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
\t\`task_id\` text NOT NULL,
\t\`round\` integer NOT NULL,
\t\`ordinal\` integer NOT NULL,
\t\`type\` text NOT NULL,
\t\`recipe_id\` text,
\t\`recipe_version\` integer,
\t\`prompt\` text NOT NULL,
\t\`references_json\` text NOT NULL,
\t\`depends_on_json\` text NOT NULL,
\t\`status\` text NOT NULL,
\t\`result_parts_json\` text,
\t\`error\` text,
\t\`created_at\` integer NOT NULL,
\t\`updated_at\` integer NOT NULL,
\t\`completed_at\` integer
);
--> statement-breakpoint
INSERT INTO \`__new_subtasks\`("id", "task_id", "round", "ordinal", "type", "recipe_id", "recipe_version", "prompt", "references_json", "depends_on_json", "status", "result_parts_json", "error", "created_at", "updated_at", "completed_at") SELECT "id", "task_id", 0, "ordinal", "type", "recipe_id", "recipe_version", "prompt", "references_json", "depends_on_json", "status", "result_parts_json", "error", "created_at", "updated_at", "completed_at" FROM \`subtasks\`;--> statement-breakpoint
DROP TABLE \`subtasks\`;--> statement-breakpoint
ALTER TABLE \`__new_subtasks\` RENAME TO \`subtasks\`;--> statement-breakpoint
CREATE UNIQUE INDEX \`idx_subtasks_task_ordinal\` ON \`subtasks\` (\`task_id\`,\`ordinal\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_task_round\` ON \`subtasks\` (\`task_id\`,\`round\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_status\` ON \`subtasks\` (\`status\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_created_at\` ON \`subtasks\` (\`created_at\`);`
  }
};

export default dbMigrations;
