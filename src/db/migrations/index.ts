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
CREATE INDEX \`idx_notify_tasks_created_at\` ON \`notify_tasks\` (\`created_at\`);`
  }
};

export default dbMigrations;
