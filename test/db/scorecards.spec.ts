/**
 * Unit tests for the `scorecards` data layer (src/db/models/scorecards.ts).
 *
 * Each test constructs a real AgentDB against a fresh DO storage so every query
 * runs through the actual Drizzle + SQLite stack with real migrations — no
 * mocks, no stubs. Mirrors test/db/subtasks.spec.ts.
 *
 * The table is a recency ledger, not a lifecycle: nothing closes a card (the ARC
 * API retires an idle one on its own), so what these specs pin is the clock —
 * which card `findRecent` picks, and that `touch` moves it.
 */
import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { AgentDB } from "@/db/db";
import dbMigrations from "@/db/migrations";
import { withScorecards, freshStub, doStorage } from "../helpers/do";

const MINUTE = 60_000;

describe("scorecards.open", () => {
  it("records the card, its jar, and starts its clock", async () => {
    const card = await withScorecards("sc-open", (s) =>
      s.open("card-1", { AWSALB: "abc" })
    );
    expect(card.cardId).toBe("card-1");
    expect(card.cookies).toEqual({ AWSALB: "abc" });
    expect(card.openedAt).toBeGreaterThan(0);
    // A card is usable the instant it exists, so its clock starts already running.
    expect(card.lastUsedAt).toBe(card.openedAt);
  });

  it("round-trips the jar, which is what makes the card reachable at all", async () => {
    const card = await withScorecards("sc-jar", (s) => {
      s.open("card-1", { AWSALB: "a", AWSALBCORS: "b" });
      return s.get("card-1");
    });
    expect(card?.cookies).toEqual({ AWSALB: "a", AWSALBCORS: "b" });
  });

  it("get returns null for an unknown card", async () => {
    const card = await withScorecards("sc-missing", (s) => s.get("nope"));
    expect(card).toBeNull();
  });
});

describe("scorecards.findRecent", () => {
  it("returns nothing before any card is opened", async () => {
    const card = await withScorecards("sc-empty", (s) =>
      s.findRecent(Date.now() - 14 * MINUTE)
    );
    expect(card).toBeNull();
  });

  it("finds a card inside the window and ignores one outside it", async () => {
    const result = await runInDurableObject(
      freshStub("sc-window"),
      (instance) => {
        const { scorecards } = new AgentDB(doStorage(instance));
        scorecards.open("stale", {});
        scorecards.open("live", {});
        // Backdate `stale` past any plausible window. Raw SQL because the data
        // layer deliberately offers no way to write a past timestamp.
        void instance.sql`
          UPDATE scorecards SET last_used_at = ${Date.now() - 20 * MINUTE}
          WHERE card_id = 'stale'`;
        return {
          inWindow: scorecards.findRecent(Date.now() - 14 * MINUTE)?.cardId,
          // A window that excludes everything must return null rather than the
          // least-old card — "nothing is live" is a real answer.
          none: scorecards.findRecent(Date.now() + MINUTE)
        };
      }
    );
    expect(result.inWindow).toBe("live");
    expect(result.none).toBeNull();
  });

  it("picks the most recently used card, not the most recently opened", async () => {
    // The two orders differ exactly when an older card is still being played,
    // which is the case the reuse policy exists for.
    const cardId = await runInDurableObject(freshStub("sc-mru"), (instance) => {
      const { scorecards } = new AgentDB(doStorage(instance));
      scorecards.open("older", {});
      scorecards.open("newer", {});
      void instance.sql`
          UPDATE scorecards SET last_used_at = ${Date.now() + 5 * MINUTE}
          WHERE card_id = 'older'`;
      return scorecards.findRecent(Date.now() - 14 * MINUTE)?.cardId;
    });
    expect(cardId).toBe("older");
  });
});

describe("scorecards.touch", () => {
  it("moves the clock forward without touching openedAt", async () => {
    const result = await runInDurableObject(
      freshStub("sc-touch"),
      (instance) => {
        const { scorecards } = new AgentDB(doStorage(instance));
        const opened = scorecards.open("card-1", {});
        void instance.sql`
          UPDATE scorecards SET last_used_at = ${Date.now() - 20 * MINUTE}
          WHERE card_id = 'card-1'`;
        // Expired by the clock, then touched: this is how a long play keeps its
        // own card alive across chunks.
        const beforeTouch = scorecards.findRecent(Date.now() - 14 * MINUTE);
        scorecards.touch("card-1");
        return {
          beforeTouch,
          afterTouch: scorecards.findRecent(Date.now() - 14 * MINUTE)?.cardId,
          openedAt: scorecards.get("card-1")?.openedAt,
          originalOpenedAt: opened.openedAt
        };
      }
    );
    expect(result.beforeTouch).toBeNull();
    expect(result.afterTouch).toBe("card-1");
    expect(result.openedAt).toBe(result.originalOpenedAt);
  });

  it("is a silent no-op on an unknown card", async () => {
    await expect(
      withScorecards("sc-touch-unknown", (s) => {
        s.touch("nope");
        return s.get("nope");
      })
    ).resolves.toBeNull();
  });
});

describe("scorecards.cleanup", () => {
  it("deletes cards older than 30 days and keeps recent ones", async () => {
    const remaining = await runInDurableObject(
      freshStub("sc-cleanup"),
      (instance) => {
        const { scorecards } = new AgentDB(doStorage(instance));
        scorecards.open("old", {});
        scorecards.open("new", {});
        void instance.sql`
          UPDATE scorecards SET opened_at = ${Date.now() - 31 * 24 * 60 * MINUTE}
          WHERE card_id = 'old'`;
        scorecards.cleanup();
        return [
          ...doStorage(instance)
            .sql.exec("SELECT card_id FROM scorecards")
            .raw()
        ].flat();
      }
    );
    expect(remaining).toEqual(["new"]);
  });
});

describe("scorecards migrations", () => {
  /** Apply one bundled migration's statements to a raw DO SQLite handle. */
  function apply(
    sql: SqlStorage,
    key: "m0001" | "m0003" | "m0004" | "m0005" | "m0006"
  ) {
    const migration = dbMigrations.migrations?.[key];
    if (!migration) throw new Error(`missing migration ${key}`);
    for (const statement of migration.split("--> statement-breakpoint")) {
      sql.exec(statement);
    }
  }

  it("backfills lastUsedAt and drops the lifecycle columns", async () => {
    // Every DO instance self-migrates on wake-up, so cards written by the
    // previous deploy have to survive into the new shape with a usable clock —
    // `opened_at` is the newest moment we can prove the card was touched.
    await runInDurableObject(freshStub("migrate-scorecards"), (instance) => {
      const sql = doStorage(instance).sql;
      // m0001 only because m0004 alters `subtasks` as well as `scorecards`.
      apply(sql, "m0001");
      apply(sql, "m0003");
      apply(sql, "m0004");
      sql.exec(
        `INSERT INTO scorecards (card_id, status, cookies_json, opened_at, closed_at, summary_json)
         VALUES ('open-card', 'open', '{"AWSALB":"x"}', 1000, NULL, NULL),
                ('closed-card', 'closed', '{}', 500, 900, '{"score":7}')`
      );

      apply(sql, "m0005");
      apply(sql, "m0006");

      const rows = [
        ...sql
          .exec(
            "SELECT card_id, cookies_json, opened_at, last_used_at FROM scorecards ORDER BY card_id"
          )
          .raw()
      ];
      expect(rows).toEqual([
        ["closed-card", "{}", 500, 500],
        ["open-card", '{"AWSALB":"x"}', 1000, 1000]
      ]);

      const columns = [...sql.exec("PRAGMA table_info(scorecards)").raw()].map(
        (row) => row[1]
      );
      expect(columns).not.toContain("status");
      expect(columns).not.toContain("closed_at");
      expect(columns).not.toContain("summary_json");
    });
  });
});
