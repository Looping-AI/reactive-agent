/**
 * Unit tests for the `subtasks` data layer (src/db/models/subtasks.ts).
 *
 * Each test constructs a real AgentDB against a fresh DO storage so every query
 * runs through the actual Drizzle + SQLite stack with real migrations — no
 * mocks, no stubs (the rollback test wraps the real handle only to inject one
 * mid-create failure). Mirrors test/db/tasks.spec.ts.
 */
import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { AgentDB, type DB } from "@/db/db";
import * as schema from "@/db/schema";
import { makeSubtasks } from "@/db/models/subtasks";
import dbMigrations from "@/db/migrations";
import type { SubtaskDraft } from "@/agent/subtasks/types";
import { freshStub, doStorage, withSubtasks } from "../helpers/do";

const draft = (
  over: Partial<SubtaskDraft> & { localKey: string }
): SubtaskDraft => ({
  type: "general",
  prompt: `do ${over.localKey}`,
  references: [],
  dependsOn: [],
  ...over
});

// ---------------------------------------------------------------------------
// createDecomposition
// ---------------------------------------------------------------------------

describe("subtasks.createDecomposition", () => {
  it("persists drafts in order with ascending ids and pending status", async () => {
    const rows = await withSubtasks("decomp-order", (s) =>
      s.createDecomposition("t-1", 0, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" }),
        draft({ localKey: "c" })
      ])
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.prompt)).toEqual(["do a", "do b", "do c"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.recipeId === null)).toBe(true);
    // Autoincrement ids are strictly ascending.
    expect(rows[0].id).toBeLessThan(rows[1].id);
    expect(rows[1].id).toBeLessThan(rows[2].id);
  });

  it("resolves draft-local dependency keys to real SubtaskIds", async () => {
    const rows = await withSubtasks("decomp-deps", (s) =>
      s.createDecomposition("t-1", 0, [
        draft({ localKey: "a" }),
        draft({ localKey: "b", dependsOn: ["a"] }),
        draft({ localKey: "c", dependsOn: ["a", "b"] })
      ])
    );

    const [a, b, c] = rows;
    expect(b.dependsOn).toEqual([a.id]);
    expect(c.dependsOn).toEqual([a.id, b.id]);
  });

  it("snapshots reference role+text verbatim onto the row", async () => {
    const [row] = await withSubtasks("decomp-refs", (s) =>
      s.createDecomposition("t-1", 0, [
        draft({
          localKey: "a",
          references: [
            { role: "user", text: "<turn>hi</turn>" },
            { role: "assistant", text: "hello" }
          ]
        })
      ])
    );

    expect(row.references).toEqual([
      { role: "user", text: "<turn>hi</turn>" },
      { role: "assistant", text: "hello" }
    ]);
  });

  it("is idempotent on (taskId, round) — a retry returns the original rows unchanged", async () => {
    const { first, retry } = await withSubtasks("decomp-idempotent", (s) => {
      const first = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      const retry = s.createDecomposition("t-1", 0, [
        draft({ localKey: "x" }),
        draft({ localKey: "y" })
      ]);
      return { first, retry };
    });

    expect(retry).toHaveLength(1);
    expect(retry[0].id).toBe(first[0].id);
    expect(retry[0].prompt).toBe("do a");
  });

  it("takes a later round's decomposition despite the first round's rows", async () => {
    // The idempotency guard is per round, or a second delegation could never
    // persist anything.
    const { first, second } = await withSubtasks("decomp-rounds", (s) => {
      const first = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      const second = s.createDecomposition("t-1", 1, [
        draft({ localKey: "b" }),
        draft({ localKey: "c" })
      ]);
      return { first, second };
    });

    expect(first.map((r) => r.round)).toEqual([0]);
    expect(second.map((r) => r.round)).toEqual([1, 1]);
    expect(second.map((r) => r.prompt)).toEqual(["do b", "do c"]);
  });

  it("continues ordinals across rounds so the task keeps one stable order", async () => {
    // `ordinal` is the Task-wide position — and the column the unique index is
    // built on, so restarting at 0 each round would collide.
    const rows = await withSubtasks("decomp-ordinals", (s) => {
      s.createDecomposition("t-1", 0, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" })
      ]);
      s.createDecomposition("t-1", 1, [draft({ localKey: "c" })]);
      return s.list("t-1");
    });

    expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.round)).toEqual([0, 0, 1]);
  });

  it("keeps a later round's dependency edges inside its own round", async () => {
    const rows = await withSubtasks("decomp-round-deps", (s) => {
      s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      return s.createDecomposition("t-1", 1, [
        draft({ localKey: "b" }),
        draft({ localKey: "c", dependsOn: ["b"] })
      ]);
    });

    const [b, c] = rows;
    expect(c.dependsOn).toEqual([b.id]);
  });

  it("rejects an empty decomposition", async () => {
    await expect(
      withSubtasks("decomp-empty", (s) => s.createDecomposition("t-1", 0, []))
    ).rejects.toThrow(/1\.\.8/);
  });

  it("rejects more than 8 subtasks", async () => {
    const drafts = Array.from({ length: 9 }, (_, i) =>
      draft({ localKey: `k${i}` })
    );
    await expect(
      withSubtasks("decomp-toomany", (s) =>
        s.createDecomposition("t-1", 0, drafts)
      )
    ).rejects.toThrow(/1\.\.8/);
  });

  it("rejects duplicate local keys", async () => {
    await expect(
      withSubtasks("decomp-dupkey", (s) =>
        s.createDecomposition("t-1", 0, [
          draft({ localKey: "a" }),
          draft({ localKey: "a" })
        ])
      )
    ).rejects.toThrow(/duplicate/);
  });

  it("rejects a dependency on an unknown key", async () => {
    await expect(
      withSubtasks("decomp-unknowndep", (s) =>
        s.createDecomposition("t-1", 0, [
          draft({ localKey: "a", dependsOn: ["z"] })
        ])
      )
    ).rejects.toThrow(/unknown key/);
  });

  it("rejects a self-dependency", async () => {
    await expect(
      withSubtasks("decomp-selfdep", (s) =>
        s.createDecomposition("t-1", 0, [
          draft({ localKey: "a", dependsOn: ["a"] })
        ])
      )
    ).rejects.toThrow(/itself/);
  });

  it("enforces unique (task_id, ordinal) at the schema level", async () => {
    await expect(
      runInDurableObject(freshStub("decomp-unique"), (instance) => {
        void new AgentDB(doStorage(instance));
        const insert = () =>
          void instance.sql`
            INSERT INTO subtasks
              (task_id, round, ordinal, type, prompt, references_json,
               depends_on_json, status, created_at, updated_at)
            VALUES ('t-1', 0, 0, 'general', 'p', '[]', '[]', 'pending', 1, 1)
          `;
        insert();
        insert();
      })
    ).rejects.toThrow(/UNIQUE constraint/);
  });

  it("continues ordinals above the highest, not from a row count", async () => {
    // A gap — cleanup deleting part of a Task — must not hand a later round an
    // ordinal that is still taken, which a count-based sequence would.
    const rows = await runInDurableObject(
      freshStub("decomp-ordinal-gap"),
      (instance) => {
        const { subtasks } = new AgentDB(doStorage(instance));
        subtasks.createDecomposition("t-1", 0, [
          draft({ localKey: "a" }),
          draft({ localKey: "b" }),
          draft({ localKey: "c" })
        ]);
        instance.sql`DELETE FROM subtasks WHERE task_id = 't-1' AND ordinal < 2`;
        subtasks.createDecomposition("t-1", 1, [draft({ localKey: "d" })]);
        return subtasks.list("t-1");
      }
    );

    expect(rows.map((r) => r.ordinal)).toEqual([2, 3]);
  });

  it("requires round at the schema level (no default to fall back on)", async () => {
    await expect(
      runInDurableObject(freshStub("decomp-round-required"), (instance) => {
        void new AgentDB(doStorage(instance));
        void instance.sql`
          INSERT INTO subtasks
            (task_id, ordinal, type, prompt, references_json,
             depends_on_json, status, created_at, updated_at)
          VALUES ('t-1', 0, 'general', 'p', '[]', '[]', 'pending', 1, 1)
        `;
      })
    ).rejects.toThrow(/NOT NULL constraint failed: subtasks.round/);
  });

  it("rolls back the whole create when a statement fails mid-create", async () => {
    const result = await runInDurableObject(
      freshStub("decomp-rollback"),
      (instance) => {
        const storage = doStorage(instance);
        const { subtasks } = new AgentDB(storage);
        const db = drizzle(storage, { schema });
        // Real handle in every way, except reaching for `update` (pass 2, the
        // dependency-edge rewrite) throws — a mid-create failure after pass 1
        // has already inserted rows.
        const failing = new Proxy(db, {
          get(target, prop) {
            if (prop === "update") {
              throw new Error("simulated mid-create failure");
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          }
        }) as DB;

        const drafts = [
          draft({ localKey: "a" }),
          draft({ localKey: "b", dependsOn: ["a"] })
        ];
        let thrown = "";
        try {
          makeSubtasks(failing).createDecomposition("t-1", 0, drafts);
        } catch (e) {
          thrown = e instanceof Error ? e.message : String(e);
        }
        const afterFailure = subtasks.list("t-1");
        // A retry against the healthy handle starts from a clean slate.
        const retried = subtasks.createDecomposition("t-1", 0, drafts);
        return { thrown, afterFailure, retried };
      }
    );

    expect(result.thrown).toMatch(/simulated mid-create failure/);
    expect(result.afterFailure).toEqual([]);
    expect(result.retried).toHaveLength(2);
    expect(result.retried[1].dependsOn).toEqual([result.retried[0].id]);
  });
});

// ---------------------------------------------------------------------------
// get / list
// ---------------------------------------------------------------------------

describe("subtasks migrations", () => {
  /** Apply one bundled migration's statements to a raw DO SQLite handle. */
  function apply(sql: SqlStorage, key: "m0001" | "m0002") {
    const migration = dbMigrations.migrations?.[key];
    if (!migration) throw new Error(`missing migration ${key}`);
    for (const statement of migration.split("--> statement-breakpoint")) {
      sql.exec(statement);
    }
  }

  it("backfills rows written before the round column existed", async () => {
    // Every DO instance self-migrates on wake-up, so a caller with in-flight
    // Subtasks from the previous deploy must read back as round 0 — not null,
    // which every round-scoped query would then miss.
    await runInDurableObject(freshStub("migrate-round"), (instance) => {
      const sql = doStorage(instance).sql;
      apply(sql, "m0001");
      sql.exec(
        `INSERT INTO subtasks (task_id, ordinal, type, prompt, references_json,
           depends_on_json, status, created_at, updated_at)
         VALUES ('t-1', 0, 'general', 'do a', '[]', '[]', 'pending', 1, 1)`
      );

      apply(sql, "m0002");

      const rows = [...sql.exec("SELECT round FROM subtasks").raw()];
      expect(rows).toEqual([[0]]);
    });
  });
});

describe("subtasks.get / list", () => {
  it("get returns null for an unknown id", async () => {
    const row = await withSubtasks("get-missing", (s) => s.get(999));
    expect(row).toBeNull();
  });

  it("list is scoped to a task and ordered by ordinal", async () => {
    const rows = await withSubtasks("list-scope", (s) => {
      s.createDecomposition("t-1", 0, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" })
      ]);
      s.createDecomposition("t-2", 0, [draft({ localKey: "c" })]);
      return s.list("t-1");
    });

    expect(rows.map((r) => r.prompt)).toEqual(["do a", "do b"]);
  });

  it("listRound sees one round's DAG, list sees every round", async () => {
    const { round0, round1, all } = await withSubtasks("list-round", (s) => {
      s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      s.createDecomposition("t-1", 1, [draft({ localKey: "b" })]);
      return {
        round0: s.listRound("t-1", 0),
        round1: s.listRound("t-1", 1),
        all: s.list("t-1")
      };
    });

    // The scheduler drives one round at a time; a sibling round's rows would
    // only widen a projection that has a size cap.
    expect(round0.map((r) => r.prompt)).toEqual(["do a"]);
    expect(round1.map((r) => r.prompt)).toEqual(["do b"]);
    expect(all.map((r) => r.prompt)).toEqual(["do a", "do b"]);
  });
});

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

describe("subtasks transitions", () => {
  it("start moves pending -> running and records recipe id/version", async () => {
    const row = await withSubtasks("start", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      const ok = s.start(a.id, { recipeId: "default", recipeVersion: 1 });
      expect(ok).toBe(true);
      return s.get(a.id);
    });

    expect(row?.status).toBe("running");
    expect(row?.recipeId).toBe("default");
    expect(row?.recipeVersion).toBe(1);
  });

  it("start is a no-op on a non-pending subtask", async () => {
    const ok = await withSubtasks("start-guard", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      s.start(a.id, { recipeId: "default", recipeVersion: 1 });
      return s.start(a.id, { recipeId: "default", recipeVersion: 1 });
    });
    expect(ok).toBe(false);
  });

  it("complete persists result parts and completedAt from running", async () => {
    const row = await withSubtasks("complete", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      s.start(a.id, { recipeId: "default", recipeVersion: 1 });
      const ok = s.complete(a.id, [{ kind: "text", text: "the answer" }]);
      expect(ok).toBe(true);
      return s.get(a.id);
    });

    expect(row?.status).toBe("completed");
    expect(row?.resultParts).toEqual([{ kind: "text", text: "the answer" }]);
    expect(row?.completedAt).not.toBeNull();
  });

  it("complete is a no-op when not running (cannot skip pending -> completed)", async () => {
    const ok = await withSubtasks("complete-guard", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      return s.complete(a.id, [{ kind: "text", text: "x" }]);
    });
    expect(ok).toBe(false);
  });

  it("complete rejects a result with no non-empty text part", async () => {
    await expect(
      withSubtasks("complete-empty", (s) => {
        const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
        s.start(a.id, { recipeId: "default", recipeVersion: 1 });
        return s.complete(a.id, [{ kind: "text", text: "   " }]);
      })
    ).rejects.toThrow(/non-empty/);
  });

  it("skip moves pending -> skipped", async () => {
    const row = await withSubtasks("skip", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      const ok = s.skip(a.id);
      expect(ok).toBe(true);
      return s.get(a.id);
    });
    expect(row?.status).toBe("skipped");
  });

  it("cancelPending cancels only pending subtasks and leaves running ones", async () => {
    const { canceled, states } = await withSubtasks("cancel", (s) => {
      const rows = s.createDecomposition("t-1", 0, [
        draft({ localKey: "a" }),
        draft({ localKey: "b" }),
        draft({ localKey: "c" })
      ]);
      // a is running, b/c pending
      s.start(rows[0].id, { recipeId: "default", recipeVersion: 1 });
      const canceled = s.cancelPending("t-1");
      const states = s.list("t-1").map((r) => r.status);
      return { canceled, states };
    });

    expect(canceled).toBe(2);
    expect(states).toEqual(["running", "canceled", "canceled"]);
  });

  it("cancelRunning transitions a running subtask whose late result was discarded", async () => {
    const { applied, row } = await withSubtasks("cancel-running", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      s.start(a.id, { recipeId: "default", recipeVersion: 1 });
      const applied = s.cancelRunning(a.id);
      return { applied, row: s.get(a.id) };
    });

    expect(applied).toBe(true);
    expect(row?.status).toBe("canceled");
    expect(row?.completedAt).not.toBeNull();
  });

  it("cancelRunning is a no-op on a pending subtask", async () => {
    const { applied, status } = await withSubtasks(
      "cancel-running-pending",
      (s) => {
        const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
        const applied = s.cancelRunning(a.id);
        return { applied, status: s.get(a.id)?.status };
      }
    );

    expect(applied).toBe(false);
    expect(status).toBe("pending");
  });

  it("cancelRunning cannot overwrite a terminal result", async () => {
    const { applied, status } = await withSubtasks(
      "cancel-running-done",
      (s) => {
        const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
        s.start(a.id, { recipeId: "default", recipeVersion: 1 });
        s.complete(a.id, [{ kind: "text", text: "done" }]);
        const applied = s.cancelRunning(a.id);
        return { applied, status: s.get(a.id)?.status };
      }
    );

    expect(applied).toBe(false);
    expect(status).toBe("completed");
  });

  it("fail persists the error from running", async () => {
    const { applied, row } = await withSubtasks("fail-running", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      s.start(a.id, { recipeId: "default", recipeVersion: 1 });
      const applied = s.fail(a.id, "retries exhausted");
      return { applied, row: s.get(a.id) };
    });

    expect(applied).toBe(true);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("retries exhausted");
    expect(row?.completedAt).not.toBeNull();
  });

  it("fail lands on a subtask that threw before it was ever claimed", async () => {
    const { applied, row } = await withSubtasks("fail-pending", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      const applied = s.fail(a.id, "never started");
      return { applied, row: s.get(a.id) };
    });

    expect(applied).toBe(true);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("never started");
  });

  it("fail cannot overwrite a terminal result", async () => {
    const { applied, row } = await withSubtasks("fail-done", (s) => {
      const [a] = s.createDecomposition("t-1", 0, [draft({ localKey: "a" })]);
      s.start(a.id, { recipeId: "default", recipeVersion: 1 });
      s.complete(a.id, [{ kind: "text", text: "done" }]);
      const applied = s.fail(a.id, "too late");
      return { applied, row: s.get(a.id) };
    });

    expect(applied).toBe(false);
    expect(row?.status).toBe("completed");
    expect(row?.resultParts).toEqual([{ kind: "text", text: "done" }]);
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("subtasks.cleanup", () => {
  it("deletes rows older than 30 days and keeps recent ones", async () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;

    const result = await runInDurableObject(
      freshStub("subtasks-cleanup"),
      (instance) => {
        const { subtasks } = new AgentDB(doStorage(instance));
        const old = subtasks.createDecomposition("t-old", 0, [
          draft({ localKey: "a" })
        ]);
        subtasks.createDecomposition("t-new", 0, [draft({ localKey: "b" })]);
        void instance.sql`
          UPDATE subtasks SET created_at = ${thirtyOneDaysAgo} WHERE task_id = 't-old'
        `;
        subtasks.cleanup();
        return { old: subtasks.get(old[0].id), recent: subtasks.list("t-new") };
      }
    );

    expect(result.old).toBeNull();
    expect(result.recent).toHaveLength(1);
  });
});
