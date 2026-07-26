import type { ToolFamilyContext } from "@/agent/tools";
import type { WorkspaceHandle } from "@/subagent/workspace";
import type { ProgressEvent, SubtaskRuntime } from "@/agent/subtasks/types";
import type { SubtaskParams } from "@/recipes/types";
import type { ScorecardStore } from "@/recipes/arc-game/scorecard-tools";
import type { Scorecard, ScorecardSummary } from "@/recipes/arc-game/types";

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
      // The arc-game family is gated on these, so default to a usable pair;
      // pass `{ params: {} }` to exercise the missing-params path.
      params: over.params ?? { card_id: "card-1", game_id: "ls20-abc" },
      runtime: over.runtime ?? {}
    }
  };
}

/**
 * In-memory {@link ScorecardStore} backed by a Map — the same guarded semantics
 * as `db.scorecards` (close only applies to an open card) without a DO.
 */
export function memStore(): ScorecardStore {
  const cards = new Map<string, Scorecard>();
  return {
    open(cardId, cookies) {
      const card: Scorecard = {
        cardId,
        status: "open",
        cookies,
        openedAt: Date.now(),
        closedAt: null,
        summary: null
      };
      cards.set(cardId, card);
      return card;
    },
    get: (cardId) => cards.get(cardId) ?? null,
    listOpen: () => [...cards.values()].filter((c) => c.status === "open"),
    listRecent: (limit) =>
      [...cards.values()]
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, limit),
    close(cardId: string, summary: ScorecardSummary) {
      const card = cards.get(cardId);
      if (!card || card.status !== "open") return false;
      cards.set(cardId, {
        ...card,
        status: "closed",
        closedAt: Date.now(),
        summary
      });
      return true;
    }
  };
}

/** Invoke a tool's `execute` with a throwaway options object. */
export function callTool(tool: unknown, input: unknown): Promise<string> {
  const t = tool as { execute: (i: unknown, o: unknown) => Promise<string> };
  return t.execute(input, {});
}
