/**
 * Integration coverage for the arc tools against the **real** ARC-AGI-3 API,
 * recorded once and replayed on CI (VCR pattern via undici SnapshotAgent — see
 * test/helpers/vcr.ts). `setupRecording()` gives each test its own cassette,
 * auto-named from the file + describe + test names (test/helpers/vcr-spec.ts),
 * stored under test/snapshots/.
 *
 * Unlike tools.spec.ts, this spec does NOT stub `fetch`: the tools' real global
 * fetch flows workerd → Miniflare → the VCR agent, which records real responses
 * (`npm run test:record`, needs a real `ARC_API_KEY` in `.env.test` — see
 * .env.test.example; add `-- -t "<name>"` to record one test) and replays them
 * from the committed cassette otherwise. Assertions are on response *shape*, not
 * exact values, so re-recording a different game doesn't churn them.
 *
 * A missing cassette **fails** the test with a "record it" message (never skips),
 * so an unrecorded spec is visible in CI.
 *
 * This drives the whole lifecycle across both owners, in the order the agents
 * really perform it: the main agent lists games and opens a card, a subagent
 * plays on it, and the main agent closes the card for the score.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { buildArcGameTools } from "@/recipes/arc-game/tools";
import { buildArcScorecardTools } from "@/recipes/arc-game/scorecard-tools";
import { makeArcClient } from "@/recipes/arc-game/client";
import { parseGrid } from "@/recipes/arc-game/analysis";
import type { ArcSession } from "@/recipes/arc-game/types";
import { ctx, callTool, memStore } from "./helpers";
import { setupRecording } from "../../helpers/vcr-spec";

setupRecording();

/**
 * The game to exercise. Its prefix must match a game in the ARC catalog at
 * record time; change it to a currently-available game when re-recording.
 */
const RECORD_GAME = "r11l";

/** Pull the exact game id out of a rendered `- <id> (Title) [tags]` listing. */
function firstIdMatching(listing: string, prefix: string): string {
  const line = listing
    .split("\n")
    .find((l) => l.startsWith(`- ${prefix}`))
    ?.trim();
  if (!line) throw new Error(`no game matching ${prefix} in:\n${listing}`);
  return line.split(" ")[1];
}

describe("arc (recorded real API)", () => {
  // Real network round-trips (plus the client's own 429 backoff, up to ~8s per
  // retried request) comfortably blow past Vitest's 5s default when actually
  // hitting the live API to record — only matters for `npm run test:record`;
  // playback replays the cassette in milliseconds.
  it(
    "opens a card, plays a real game on it, and closes it for a score",
    { timeout: 60_000 },
    async () => {
      const store = memStore();
      const parent = buildArcScorecardTools({
        store,
        client: makeArcClient(env.ARC_API_KEY)
      });

      // 1. The main agent finds the exact game id.
      const listing = await callTool(parent.arc_list_games, {});
      const gameId = firstIdMatching(listing, RECORD_GAME);

      // 2. …and opens a scorecard to play it on.
      const opened = await callTool(parent.arc_open_scorecard, {});
      expect(opened).toContain("Opened scorecard");
      const cardId = store.listOpen()[0].cardId;
      expect(cardId).toBeTruthy();

      // 3. The subagent plays: the ids arrive as its Subtask's params, and the
      //    session the card is pinned to as the runtime the parent resolved.
      //    Without that jar the ARC API cannot see the card at all.
      const { ctx: c } = ctx(env.ARC_API_KEY, {
        params: { card_id: cardId, game_id: gameId },
        runtime: { cookies: store.get(cardId)?.cookies ?? {} }
      });
      const play = buildArcGameTools(c);
      const started = await callTool(play.tools.arc_reset_game, {});
      expect(started).toContain("Started");

      const session =
        await c.workspace.readJson<ArcSession>("arc/session.json");
      expect(session).not.toBeNull();
      expect(session?.cardId).toBe(cardId);
      expect(session?.guid).toBeTruthy();
      expect(session?.availableActions.length).toBeGreaterThan(0);
      expect(typeof session?.state).toBe("string");

      // The board is stored as hex rows; parsing it back must yield the real
      // ARC frame's 64×64 grid of color indices.
      expect(typeof session?.lastGridHex).toBe("string");
      const grid = parseGrid(session?.lastGridHex ?? "");
      expect(grid).toHaveLength(64);
      expect(grid[0]).toHaveLength(64);
      expect(
        grid.flat().every((c) => Number.isInteger(c) && c >= 0 && c < 16)
      ).toBe(true);

      // 4. The main agent closes the card and gets the aggregate.
      const closed = await callTool(parent.arc_close_scorecard, {
        card_id: cardId
      });
      expect(closed).toContain("closed");
      expect(closed).toContain("Score");

      const card = store.get(cardId);
      expect(card?.status).toBe("closed");
      expect(card?.summary?.card_id).toBe(cardId);
      // One environment per game played on the card, one run per RESET.
      expect(card?.summary?.environments.length).toBeGreaterThan(0);
      expect(card?.summary?.environments[0].runs.length).toBeGreaterThan(0);
      expect(typeof card?.summary?.score).toBe("number");
      expect(typeof card?.summary?.total_actions).toBe("number");
    }
  );
});
