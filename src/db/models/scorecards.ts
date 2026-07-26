import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { scorecards } from "@/db/schema";
import type { DB } from "@/db/db";
import type {
  CookieJar,
  Scorecard,
  ScorecardStatus,
  ScorecardSummary
} from "@/recipes/arc-game/types";

/**
 * Loose on purpose: the stored summary is the *only* record of a closed card's
 * score (the API cannot re-read one), so unknown keys are preserved rather than
 * stripped. The fields asserted here are the ones the tools actually render.
 */
const runSchema = z.looseObject({
  guid: z.string(),
  actions: z.number(),
  completed: z.boolean(),
  levels_completed: z.number(),
  resets: z.number(),
  score: z.number(),
  state: z.enum(["NOT_STARTED", "NOT_FINISHED", "WIN", "GAME_OVER"])
});

const environmentSchema = z.looseObject({
  id: z.string(),
  actions: z.number(),
  completed: z.boolean(),
  level_count: z.number(),
  levels_completed: z.number(),
  resets: z.number(),
  score: z.number(),
  runs: z.array(runSchema)
});

const cookiesSchema = z.record(z.string(), z.string());

const summarySchema = z.looseObject({
  card_id: z.string(),
  score: z.number(),
  total_actions: z.number(),
  total_environments: z.number(),
  total_environments_completed: z.number(),
  total_levels: z.number(),
  total_levels_completed: z.number(),
  environments: z.array(environmentSchema)
});

type ScorecardRow = typeof scorecards.$inferSelect;

/**
 * Query methods for the `scorecards` table (ARC-AGI-3 cards the main agent has
 * opened).
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as `db.scorecards.*`.
 * durable-sqlite is synchronous, so these return plain values. {@link close} is a
 * guarded transition filtered on the expected current status, so closing an
 * already-closed card matches no row and is a no-op rather than an overwrite —
 * the first close is the one that recorded the real score.
 *
 * There is deliberately no `cleanup()`: unlike tasks and subtasks, these rows are
 * permanent. The API exposes no way to list scorecards or re-read a closed one.
 */
export function makeScorecards(db: DB) {
  const rowToScorecard = (row: ScorecardRow): Scorecard => ({
    cardId: row.cardId,
    status: row.status as ScorecardStatus,
    cookies: cookiesSchema.parse(JSON.parse(row.cookiesJson)),
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    summary:
      row.summaryJson === null
        ? null
        : (summarySchema.parse(JSON.parse(row.summaryJson)) as ScorecardSummary)
  });

  return {
    /**
     * Record a freshly opened card together with the cookie jar the open call
     * returned. The jar is not optional bookkeeping: the ARC API pins the card to
     * that session, so a row without it names a card nobody can reach.
     */
    open(cardId: string, cookies: CookieJar): Scorecard {
      const row = db
        .insert(scorecards)
        .values({
          cardId,
          cookiesJson: JSON.stringify(cookies),
          openedAt: Date.now()
        })
        .returning()
        .get();
      return rowToScorecard(row);
    },

    /** Load one card by id. */
    get(cardId: string): Scorecard | null {
      const row = db
        .select()
        .from(scorecards)
        .where(eq(scorecards.cardId, cardId))
        .get();
      return row ? rowToScorecard(row) : null;
    },

    /** Every card still accepting plays, most recently opened first. */
    listOpen(): Scorecard[] {
      return db
        .select()
        .from(scorecards)
        .where(eq(scorecards.status, "open"))
        .orderBy(desc(scorecards.openedAt))
        .all()
        .map(rowToScorecard);
    },

    /** The most recently opened cards regardless of status. */
    listRecent(limit: number): Scorecard[] {
      return db
        .select()
        .from(scorecards)
        .orderBy(desc(scorecards.openedAt))
        .limit(limit)
        .all()
        .map(rowToScorecard);
    },

    /**
     * Persist a card's terminal aggregate: guarded `open -> closed`. Returns
     * false if the card was unknown or already closed.
     */
    close(cardId: string, summary: ScorecardSummary): boolean {
      const closed = db
        .update(scorecards)
        .set({
          status: "closed" satisfies ScorecardStatus,
          closedAt: Date.now(),
          summaryJson: JSON.stringify(summary)
        })
        .where(
          and(eq(scorecards.cardId, cardId), eq(scorecards.status, "open"))
        )
        .returning({ cardId: scorecards.cardId })
        .all();
      return closed.length > 0;
    }
  };
}
