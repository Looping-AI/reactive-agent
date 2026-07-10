import { describe, it, expect } from "vitest";
import { buildTools, recall } from "@/agent/tools";
import type { RecallDeps } from "@/agent/tools";
import type { RecallIndex } from "@/agent/recall";
import type { QuickActionBinding } from "agents/browser";

/** Recall deps backed by a fake index returning one canned match. */
function recallDeps(hasArchive: boolean): RecallDeps {
  const index: RecallIndex = {
    async upsert() {
      return { ids: [], count: 0 };
    },
    async query() {
      return {
        matches: [
          {
            id: "m1",
            score: 0.8,
            metadata: { role: "user", text: "teal is my favorite" }
          } as VectorizeMatch
        ],
        count: 1
      };
    }
  };
  return {
    index,
    namespace: "ns:1",
    embed: async (texts) => texts.map(() => [0, 1, 2]),
    hasArchive
  };
}

/**
 * Stub Browser Rendering binding. Never invoked here — the Quick Action tools
 * only hit `quickAction` inside their `execute`, which the tool-registration
 * assertions below never call.
 */
const browserStub: QuickActionBinding = {
  async quickAction() {
    throw new Error("not called in registration tests");
  }
};

describe("recall", () => {
  it("returns the archived matches when there is an archive", async () => {
    const out = await recall(recallDeps(true), { query: "favorite color" });
    expect(out.note).toBeUndefined();
    expect(out.results).toEqual([
      { score: 0.8, role: "user", text: "teal is my favorite" }
    ]);
  });

  it("returns an empty note when nothing has been archived yet", async () => {
    const out = await recall(recallDeps(false), { query: "anything" });
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/no older history/i);
  });
});

describe("buildTools", () => {
  it("exposes no tools by default (Session contributes set_context in the loop)", () => {
    const tools = buildTools();
    expect(Object.keys(tools)).toEqual([]);
  });

  it("omits recall until this caller has compacted at least once", () => {
    const tools = buildTools(recallDeps(false));
    expect(Object.keys(tools)).toEqual([]);
  });

  it("adds the recall tool once an archive exists", () => {
    const tools = buildTools(recallDeps(true));
    expect(Object.keys(tools).sort()).toEqual(["recall"]);
  });

  it("adds the browser tools when a Browser Rendering binding is present", () => {
    const tools = buildTools(undefined, browserStub);
    expect(Object.keys(tools).sort()).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
  });

  it("adds both browser and recall tools together", () => {
    const tools = buildTools(recallDeps(true), browserStub);
    expect(Object.keys(tools).sort()).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape",
      "recall"
    ]);
  });
});
