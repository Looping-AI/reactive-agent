import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createQuickActionTools } from "agents/browser/ai";
import type { QuickActionBinding } from "agents/browser";
import type { Embed } from "./model";
import { recallSearch, type RecallIndex, type RecallResult } from "./recall";
import { RECALL_TOP_K } from "@/config";

/**
 * The agent's tools. Pure handlers are exported separately from the AI-SDK
 * `tool()` wiring so they unit-test without an LLM. Tools that depend on a
 * per-instance binding (Vectorize, Browser Rendering) are gated: registered
 * only when their dependency is present, with the binding closed over so it is
 * never model input.
 */

/**
 * Per-instance dependencies for the `recall` tool. The Vectorize binding, the
 * caller-bound namespace, and the embed fn are all closed over — never tool
 * input — so the model can only ever supply a query string. `hasArchive` is the
 * gate: false until this caller's history has been compacted at least once.
 */
export interface RecallDeps {
  index: RecallIndex;
  namespace: string;
  embed: Embed;
  hasArchive: boolean;
}

export interface RecallToolResult {
  results: RecallResult[];
  /** Set when there is nothing to search yet, so the model doesn't over-read empty results. */
  note?: string;
}

/**
 * Semantically search this caller's archived (compacted-away) history. Pure
 * handler split from the AI-SDK wiring; the namespace/index/embed come from the
 * closure, only `query`/`limit` from the model.
 */
export async function recall(
  deps: RecallDeps,
  args: { query: string; limit?: number }
): Promise<RecallToolResult> {
  if (!deps.hasArchive) {
    return { results: [], note: "No older history has been archived yet." };
  }
  const results = await recallSearch(
    deps.index,
    deps.namespace,
    args.query,
    deps.embed,
    args.limit ?? RECALL_TOP_K
  );
  return { results };
}

/**
 * Web read/scrape tools (`browser_markdown`, `browser_extract`, `browser_links`,
 * `browser_scrape`), backed by Cloudflare Browser Rendering Quick Actions. The
 * binding is closed over, never model input; `maxChars` is lowered from the SDK
 * default to protect the small chat model's context window. `content` (raw HTML)
 * stays opt-in.
 */
export function buildBrowserTools(browser: QuickActionBinding): ToolSet {
  return createQuickActionTools({ browser, maxChars: 20000 });
}

/**
 * Build the toolset for a validated Recipe's tool families (subagent
 * executions). Families are gated on binding presence like {@link buildTools};
 * unknown families are skipped (defense-in-depth — `validateRecipe` already
 * dropped them). `recall` and the Session's `set_context` are structurally
 * impossible here: they are not in the family map, and a subagent has no
 * Session or recall dependencies to wire them to.
 */
export function buildRecipeTools(
  toolFamilies: string[],
  browser?: QuickActionBinding
): ToolSet {
  const tools: ToolSet = {};
  for (const family of toolFamilies) {
    if (family === "browser" && browser) {
      Object.assign(tools, buildBrowserTools(browser));
    }
  }
  return tools;
}

/**
 * Build the toolset for a turn. Tools are gated on their per-instance
 * dependency: `recall` only once this caller's history has been compacted at
 * least once (`recallDeps.hasArchive`) — nothing to search before that — and the
 * browser tools only when a Browser Rendering binding is available. The Session
 * contributes its own `set_context` tool on top of these (merged in the loop),
 * so an otherwise-empty toolset here is fine.
 */
export function buildTools(
  recallDeps?: RecallDeps,
  browser?: QuickActionBinding
): ToolSet {
  const tools: ToolSet = {};

  if (browser) {
    Object.assign(tools, buildBrowserTools(browser));
  }

  if (recallDeps?.hasArchive) {
    tools.recall = tool({
      description:
        "Search your own older conversation history with this caller that has scrolled out of the live context window (it was summarized during compaction). Use this to recall specific past details — quotes, decisions, facts — that you no longer have verbatim. Returns the most semantically similar archived messages with their author/channel/timestamp when known.",
      inputSchema: z.object({
        query: z.string().describe("What to look for in the archived history"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max number of matches to return (default 5)")
      }),
      execute: async (args) => recall(recallDeps, args)
    });
  }

  return tools;
}
