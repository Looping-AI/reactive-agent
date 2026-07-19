/**
 * Integration coverage for the arc-game tools against the **real** ARC-AGI-3 API,
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
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { buildArcGameTools } from "@/recipes/arc-game/tools";
import type { ArcSession } from "@/recipes/arc-game/types";
import { ctx, callTool } from "./helpers";
import { setupRecording } from "../../helpers/vcr-spec";

setupRecording();

/**
 * The game to exercise. Its prefix must uniquely resolve in the ARC catalog at
 * record time; change it to a currently-available game when re-recording.
 */
const RECORD_GAME = "r11l";

describe("arc-game (recorded real API)", () => {
  // Real network round-trips (plus the client's own 429 backoff, up to ~8s per
  // retried request) comfortably blow past Vitest's 5s default when actually
  // hitting the live API to record — only matters for `npm run test:record`;
  // playback replays the cassette in milliseconds.
  it(
    "starts a real game and closes the scorecard on abort",
    { timeout: 60_000 },
    async () => {
      const { ctx: c } = ctx(env.ARC_API_KEY);
      const built = buildArcGameTools(c);

      const out = await callTool(built.tools.arc_start_game, {
        game: RECORD_GAME
      });
      expect(out).toContain("Started");

      const session =
        await c.workspace.readJson<ArcSession>("arc/session.json");
      expect(session).not.toBeNull();
      expect(session?.cardId).toBeTruthy();
      expect(session?.guid).toBeTruthy();
      expect(session?.availableActions.length).toBeGreaterThan(0);
      expect(typeof session?.state).toBe("string");

      // lastFrame is a 2-D grid of numbers (the parsed ARC frame).
      const grid = session?.lastFrame;
      expect(Array.isArray(grid)).toBe(true);
      expect(Array.isArray(grid?.[0])).toBe(true);
      expect(typeof grid?.[0]?.[0]).toBe("number");

      // abort must close the open scorecard (a real POST /api/scorecard/close).
      await built.abort?.(c);
      const closed = await c.workspace.readJson<ArcSession>("arc/session.json");
      expect(closed?.scorecardClosed).toBe(true);
    }
  );
});
