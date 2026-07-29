import { desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { scorecards } from "@/db/schema";
import type { DB } from "@/db/db";
import type { CookieJar, Scorecard } from "@/recipes/arc-game/types";

const cookiesSchema = z.record(z.string(), z.string());
const guidsSchema = z.record(z.string(), z.string());

type ScorecardRow = typeof scorecards.$inferSelect;

/** How long a scorecard row is kept before the weekly cron sweeps it. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Query methods for the `scorecards` table (ARC-AGI-3 cards this agent opened).
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as `db.scorecards.*`.
 * durable-sqlite is synchronous, so these return plain values.
 *
 * The table is a **recency ledger**, not a lifecycle: the ARC API auto-closes an
 * idle card, so the only question ever asked of it is {@link findRecent} — "is
 * there a card young enough to still be alive?" Everything else exists to keep
 * that clock honest ({@link touch}) or to reach the jar pinned to a card
 * ({@link get}).
 */
export function makeScorecards(db: DB) {
  const rowToScorecard = (row: ScorecardRow): Scorecard => ({
    cardId: row.cardId,
    cookies: cookiesSchema.parse(JSON.parse(row.cookiesJson)),
    guids: guidsSchema.parse(JSON.parse(row.guidsJson)),
    openedAt: row.openedAt,
    lastUsedAt: row.lastUsedAt
  });

  return {
    /**
     * Record a freshly opened card together with the cookie jar the open call
     * returned. The jar is not optional bookkeeping: the ARC API pins the card to
     * that session, so a row without it names a card nobody can reach.
     */
    open(cardId: string, cookies: CookieJar): Scorecard {
      const now = Date.now();
      const row = db
        .insert(scorecards)
        .values({
          cardId,
          cookiesJson: JSON.stringify(cookies),
          openedAt: now,
          lastUsedAt: now
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

    /**
     * The most recently used card still inside the caller's reuse window, or null
     * if every card is older than `since`. The single read the resolution path
     * makes — see `resolveScorecard` in `recipes/arc-game/scorecard.ts`, which
     * owns the window itself.
     */
    findRecent(since: number): Scorecard | null {
      const row = db
        .select()
        .from(scorecards)
        .where(gte(scorecards.lastUsedAt, since))
        .orderBy(desc(scorecards.lastUsedAt))
        .get();
      return row ? rowToScorecard(row) : null;
    },

    /**
     * Record the guid a RESET minted for one game on one card, so the next
     * resolution of that game rejoins the play instead of opening another.
     *
     * Read-modify-write of a JSON map rather than a `(card_id, game_id)` table:
     * durable-sqlite is synchronous and single-threaded within the DO, so this
     * cannot interleave, and every reader already loads the whole row.
     *
     * First writer wins. Two concurrent resolutions of the same game can both
     * find no guid and both RESET, and the loser's play must not overwrite the
     * guid the winner already handed out — keeping the first keeps everyone
     * afterwards on one play.
     */
    setGuid(cardId: string, gameId: string, guid: string): void {
      const row = db
        .select()
        .from(scorecards)
        .where(eq(scorecards.cardId, cardId))
        .get();
      if (!row) return;
      const guids = guidsSchema.parse(JSON.parse(row.guidsJson));
      if (guids[gameId] !== undefined) return;
      db.update(scorecards)
        .set({ guidsJson: JSON.stringify({ ...guids, [gameId]: guid }) })
        .where(eq(scorecards.cardId, cardId))
        .run();
    },

    /**
     * Restart a card's reuse clock. Called once per durable chunk of every play
     * running on the card, which is what keeps a long play's card alive: chunks
     * are bounded well under the window (see `CHUNK_SOFT_MS`), so an active card
     * is always re-touched before it can expire.
     */
    touch(cardId: string): void {
      db.update(scorecards)
        .set({ lastUsedAt: Date.now() })
        .where(eq(scorecards.cardId, cardId))
        .run();
    },

    /**
     * Delete scorecards older than 30 days (called by the weekly maintenance
     * cron). Safe in a way the old shape was not: a row holds no score, only a
     * dead card id and its jar, and a score is read back from the API on demand.
     */
    cleanup(): void {
      const cutoff = Date.now() - RETENTION_MS;
      db.delete(scorecards).where(lt(scorecards.openedAt, cutoff)).run();
    }
  };
}
