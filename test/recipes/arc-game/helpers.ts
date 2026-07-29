import type { ToolFamilyContext } from "@/agent/tools";
import type { WorkspaceHandle } from "@/subagent/workspace";
import type { ProgressEvent, SubtaskRuntime } from "@/agent/subtasks/types";
import type { SubtaskParams } from "@/recipes/types";
import type { ScorecardStore } from "@/recipes/arc-game/scorecard";
import type { Scorecard } from "@/recipes/arc-game/types";

/** In-memory {@link WorkspaceHandle} backed by a Map — no DO/SQLite needed. */
export function memHandle(): WorkspaceHandle {
  const files = new Map<string, string>();
  return {
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    exists: async (p) => files.has(p),
    remove: async (p) => files.delete(p),
    list: async () =>
      [...files.keys()].map((p) => ({
        path: p,
        type: "file" as const,
        size: 0
      })),
    readJson: async (p) => {
      const r = files.get(p);
      return r ? JSON.parse(r) : null;
    },
    writeJson: async (p, v) => void files.set(p, JSON.stringify(v))
  };
}

/**
 * Build a throwaway {@link ToolFamilyContext} for the arc-game tools, plus the
 * captured progress-event log. `apiKey` defaults to a placeholder — under VCR
 * playback the key header is excluded from the cassette, so its value is
 * irrelevant; pass the real key only when recording.
 */
export function ctx(
  apiKey = "test-key",
  over: { params?: SubtaskParams; runtime?: SubtaskRuntime } = {}
): {
  ctx: ToolFamilyContext;
  events: ProgressEvent[];
} {
  const events: ProgressEvent[] = [];
  return {
    events,
    ctx: {
      env: { ARC_API_KEY: apiKey } as unknown as Env,
      workspace: memHandle(),
      emitProgress: (e) => events.push(e),
      // The arc-game family is gated on the game param plus the leased card, so
      // default to a usable pair; pass `{ params: {} }` or `{ runtime: {} }` to
      // exercise the ungated paths.
      params: over.params ?? { game_id: "ls20-abc" },
      runtime: over.runtime ?? { cardId: "card-1" }
    }
  };
}

/**
 * In-memory {@link ScorecardStore} backed by a Map, with the same recency
 * semantics as `db.scorecards` and no DO. `now` is injected so a spec can place
 * cards on either side of the reuse window without sleeping; `seed` pre-loads
 * cards with an explicit `lastUsedAt`.
 */
export function memStore(
  seed: Scorecard[] = [],
  now: () => number = Date.now
): ScorecardStore & { all: () => Scorecard[] } {
  const cards = new Map<string, Scorecard>(seed.map((c) => [c.cardId, c]));
  return {
    open(cardId, cookies) {
      const card: Scorecard = {
        cardId,
        cookies,
        openedAt: now(),
        lastUsedAt: now()
      };
      cards.set(cardId, card);
      return card;
    },
    get: (cardId) => cards.get(cardId) ?? null,
    findRecent: (since) =>
      [...cards.values()]
        .filter((c) => c.lastUsedAt >= since)
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null,
    touch(cardId) {
      const card = cards.get(cardId);
      if (card) cards.set(cardId, { ...card, lastUsedAt: now() });
    },
    all: () => [...cards.values()]
  };
}

/** Invoke a tool's `execute` with a throwaway options object. */
export function callTool(tool: unknown, input: unknown): Promise<string> {
  const t = tool as { execute: (i: unknown, o: unknown) => Promise<string> };
  return t.execute(input, {});
}
