import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ArcClient } from "./client";
import type { CookieJar, Scorecard, ScorecardSummary } from "./types";

/**
 * The **main agent's** ARC tools: the scorecard lifecycle, plus the game
 * catalogue it needs to brief a play.
 *
 * A scorecard is the API's container for many plays — `open` mints a `card_id`,
 * each RESET starts a run inside it, and `close` returns the aggregate score.
 * Owning that here (rather than inside the playing subagent, where it used to
 * happen as a side effect of starting and winning) is what lets one card span
 * several plays and lets the user actually be told a score.
 *
 * The API has no endpoint that lists scorecards, so {@link ScorecardStore} — the
 * caller's own DO SQLite — *is* the list, and a closed card's summary is kept
 * forever because it cannot be re-read.
 *
 * Handlers are exported separately from the `tool()` wiring so they unit-test
 * without an LLM, and the store is a narrow interface (`AgentDB.scorecards`
 * satisfies it structurally) so tests can pass an in-memory fake.
 */

/** The slice of `AgentDB.scorecards` these tools need. */
export interface ScorecardStore {
  open(cardId: string, cookies: CookieJar): Scorecard;
  get(cardId: string): Scorecard | null;
  listOpen(): Scorecard[];
  listRecent(limit: number): Scorecard[];
  close(cardId: string, summary: ScorecardSummary): boolean;
}

export interface ArcScorecardDeps {
  store: ScorecardStore;
  client: ArcClient;
}

/** How many cards `arc_list_scorecards` reports. */
const RECENT_LIMIT = 20;

/** One line per game: id, title, and how it is played. */
export function renderGames(
  games: { game_id: string; title?: string; tags?: string[] }[]
): string {
  if (games.length === 0) return "(the API listed no games)";
  return games
    .map((g) => {
      const title = g.title ? ` (${g.title})` : "";
      const tags = g.tags?.length ? ` [${g.tags.join(", ")}]` : "";
      return `- ${g.game_id}${title}${tags}`;
    })
    .join("\n");
}

/** One line per card, with the final score once it is closed. */
export function renderScorecards(cards: Scorecard[]): string {
  if (cards.length === 0) return "(no scorecards yet)";
  return cards
    .map((card) => {
      if (card.status === "open") return `- ${card.cardId} — open`;
      const s = card.summary;
      const score = s
        ? `score ${s.score}, ${s.total_levels_completed}/${s.total_levels} levels, ${s.total_actions} actions`
        : "no summary recorded";
      return `- ${card.cardId} — closed (${score})`;
    })
    .join("\n");
}

/** The digest of a just-closed card: the aggregate, then a line per game. */
export function renderSummary(summary: ScorecardSummary): string {
  const header =
    `Scorecard ${summary.card_id} closed. ` +
    `Score ${summary.score} — ${summary.total_levels_completed}/${summary.total_levels} levels ` +
    `across ${summary.total_environments} game(s), ${summary.total_actions} actions.`;
  const envs = summary.environments.map(
    (env) =>
      `- ${env.id}: ${env.levels_completed}/${env.level_count} levels, ` +
      `${env.runs.length} play(s), ${env.actions} actions, score ${env.score}` +
      (env.completed ? " (completed)" : "")
  );
  return envs.length === 0 ? header : `${header}\n${envs.join("\n")}`;
}

/**
 * Close a card: verify it is one of ours and still open *before* calling the
 * API, close it, and persist the aggregate. Pure handler — the guard order
 * matters, since a card closed twice would lose the first (real) summary.
 */
export async function closeScorecard(
  deps: ArcScorecardDeps,
  cardId: string
): Promise<string> {
  const existing = deps.store.get(cardId);
  if (!existing) {
    return `No scorecard ${cardId} — you can only close a card you opened. Call arc_list_scorecards to see them.`;
  }
  if (existing.status === "closed") {
    return existing.summary
      ? `Scorecard ${cardId} is already closed.\n${renderSummary(existing.summary)}`
      : `Scorecard ${cardId} is already closed.`;
  }
  // The card is only reachable from the session that opened it, so close with
  // the stored jar — an empty one 404s even on a card we just created.
  const { summary } = await deps.client.closeScorecard(
    cardId,
    existing.cookies
  );
  deps.store.close(cardId, summary);
  return renderSummary(summary);
}

export function buildArcScorecardTools(deps: ArcScorecardDeps): ToolSet {
  return {
    arc_list_games: tool({
      description:
        "List the ARC-AGI-3 games available to play, with their exact game ids and tags describing how each is played. Use this to find the full game id before delegating a play.",
      inputSchema: z.object({}),
      execute: async () => {
        const { games } = await deps.client.listGames({});
        return renderGames(games);
      }
    }),

    arc_list_scorecards: tool({
      description:
        "List the ARC scorecards you have opened — which are still open, and the final score of the ones you closed. Reads your own records; the ARC API cannot list scorecards.",
      inputSchema: z.object({}),
      execute: async () => renderScorecards(deps.store.listRecent(RECENT_LIMIT))
    }),

    arc_open_scorecard: tool({
      description:
        "Open a new ARC scorecard and return its card id. A scorecard collects the results of every game played on it, and you get its score when you close it. Open one before delegating a play, and pass its id as the `card_id` param of the arc-game subtask.",
      inputSchema: z.object({}),
      execute: async () => {
        const { cardId, cookies } = await deps.client.openScorecard({});
        deps.store.open(cardId, cookies);
        return (
          `Opened scorecard ${cardId}. Pass this id as the \`card_id\` param of any ` +
          `arc-game subtask you delegate, and call arc_close_scorecard once those plays have finished.`
        );
      }
    }),

    arc_close_scorecard: tool({
      description:
        "Close one of your ARC scorecards and get its final score. Only do this once every play on that card has finished — closing ends the card for good, and its score cannot be read again afterwards.",
      inputSchema: z.object({
        card_id: z.string().describe("The scorecard's card id")
      }),
      execute: async ({ card_id }) => closeScorecard(deps, card_id)
    })
  };
}
