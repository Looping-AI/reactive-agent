import {
  drizzle,
  type DrizzleSqliteDODatabase
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import * as schema from "@/db/schema";
import dbMigrations from "@/db/migrations";
import { makeTasks } from "@/db/models/tasks";

export type DB = DrizzleSqliteDODatabase<typeof schema>;

/**
 * The agent's database: a single drizzle handle over the DO's SQLite, with
 * one memoized namespace per table domain (`db.tasks`, `db.users`, …).
 *
 * Constructed once per DO instance (see `ReactiveAgent.db`). Migrations run
 * once in the constructor — the durable-sqlite migrator is idempotent, so a
 * fresh `AgentDB` on every hibernation wake-up re-validates the schema safely.
 * Call `ensureReady()` (and await it) before issuing any queries to guarantee
 * migrations have completed.
 *
 * Each domain getter binds its query methods to the handle lazily and caches
 * the result, so `db.tasks` is built at most once per DO instance.
 */
export class AgentDB {
  private readonly db: DB;
  private readonly _ready: Promise<void>;
  private _tasks?: ReturnType<typeof makeTasks>;

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage, { schema });
    this._ready = migrate(this.db, dbMigrations);
  }

  ensureReady(): Promise<void> {
    return this._ready;
  }

  get tasks() {
    return (this._tasks ??= makeTasks(this.db));
  }
}
