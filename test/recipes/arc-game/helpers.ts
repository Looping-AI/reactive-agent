import type { ToolFamilyContext } from "@/agent/tools";
import type { WorkspaceHandle } from "@/subagent/workspace";
import type { ProgressEvent } from "@/agent/subtasks/types";

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
export function ctx(apiKey = "test-key"): {
  ctx: ToolFamilyContext;
  events: ProgressEvent[];
} {
  const events: ProgressEvent[] = [];
  return {
    events,
    ctx: {
      env: { ARC_API_KEY: apiKey } as unknown as Env,
      workspace: memHandle(),
      emitProgress: (e) => events.push(e)
    }
  };
}

/** Invoke a tool's `execute` with a throwaway options object. */
export function callTool(tool: unknown, input: unknown): Promise<string> {
  const t = tool as { execute: (i: unknown, o: unknown) => Promise<string> };
  return t.execute(input, {});
}
