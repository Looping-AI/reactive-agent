import { describe, it, expect } from "vitest";
import { buildRecipeTools, buildTools, recall } from "@/agent/tools";
import type { RecallDeps, ToolFamilyContext } from "@/agent/tools";
import type { RecallIndex } from "@/agent/recall";
import type { WorkspaceHandle } from "@/subagent/workspace";
import type { QuickActionBinding } from "agents/browser";
import type { ArcScorecardDeps } from "@/recipes/arc-game/scorecard-tools";
import type { ArcClient } from "@/recipes/arc-game/client";
import type { SubtaskParams } from "@/recipes/types";

/**
 * ARC deps whose store and client both throw: registration assertions never run
 * a handler, and a throw makes an accidental call obvious.
 */
function arcScorecardDeps(): ArcScorecardDeps {
  const unused = () => {
    throw new Error("not called in registration tests");
  };
  return {
    store: {
      open: unused,
      get: unused,
      listOpen: unused,
      listRecent: unused,
      close: unused
    },
    client: {
      listGames: unused,
      openScorecard: unused,
      closeScorecard: unused,
      reset: unused,
      act: unused
    } as unknown as ArcClient
  };
}

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
    const tools = buildTools({ recall: recallDeps(false) });
    expect(Object.keys(tools)).toEqual([]);
  });

  it("adds the recall tool once an archive exists", () => {
    const tools = buildTools({ recall: recallDeps(true) });
    expect(Object.keys(tools).sort()).toEqual(["recall"]);
  });

  it("adds the browser tools when a Browser Rendering binding is present", () => {
    const tools = buildTools({ browser: browserStub });
    expect(Object.keys(tools).sort()).toEqual([
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
  });

  it("adds the scorecard lifecycle tools when an ARC store is supplied", () => {
    const tools = buildTools({ arcScorecard: arcScorecardDeps() });
    expect(Object.keys(tools).sort()).toEqual([
      "arc_close_scorecard",
      "arc_list_games",
      "arc_list_scorecards",
      "arc_open_scorecard"
    ]);
  });

  it("never gives the main agent the tools that play a game", () => {
    const tools = buildTools({ arcScorecard: arcScorecardDeps() });
    expect(tools.arc_reset_game).toBeUndefined();
    expect(tools.arc_act).toBeUndefined();
    expect(tools.arc_inspect).toBeUndefined();
  });

  it("adds every family's tools together", () => {
    const tools = buildTools({
      recall: recallDeps(true),
      browser: browserStub,
      arcScorecard: arcScorecardDeps()
    });
    expect(Object.keys(tools).sort()).toEqual([
      "arc_close_scorecard",
      "arc_list_games",
      "arc_list_scorecards",
      "arc_open_scorecard",
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape",
      "recall"
    ]);
  });
});

/** A no-op workspace handle — registration tests never call the tools. */
const fakeWorkspace: WorkspaceHandle = {
  read: async () => null,
  write: async () => {},
  exists: async () => false,
  remove: async () => false,
  list: async () => [],
  readJson: async () => null,
  writeJson: async () => {}
};

/** Minimal tool-family context; only the fields a given family reads matter. */
function ctx(
  over: { browser?: QuickActionBinding; params?: SubtaskParams } = {}
): ToolFamilyContext {
  return {
    env: { BROWSER: over.browser, ARC_API_KEY: "test-key" } as unknown as Env,
    workspace: fakeWorkspace,
    emitProgress: () => {},
    // The `arc-game` type declares both of these; the family is gated on them.
    params: over.params ?? { card_id: "card-1", game_id: "ls20-abc" },
    runtime: {}
  };
}

const BROWSER_TOOLS = [
  "browser_extract",
  "browser_links",
  "browser_markdown",
  "browser_scrape"
];

describe("buildRecipeTools", () => {
  it("builds the browser tools for the browser family", () => {
    const { tools } = buildRecipeTools(
      ["browser"],
      ctx({ browser: browserStub })
    );
    expect(Object.keys(tools).sort()).toEqual(BROWSER_TOOLS);
  });

  it("skips the browser family when no binding is available", () => {
    const { tools } = buildRecipeTools(["browser"], ctx());
    expect(Object.keys(tools)).toEqual([]);
  });

  it("ignores unknown families — recall/set_context can never appear", () => {
    const { tools } = buildRecipeTools(
      ["recall", "set_context", "warp", "browser"],
      ctx({ browser: browserStub })
    );
    expect(Object.keys(tools).sort()).toEqual(BROWSER_TOOLS);
    expect(tools.recall).toBeUndefined();
    expect(tools.set_context).toBeUndefined();
  });

  it("builds the workspace tools for the workspace family", () => {
    const { tools } = buildRecipeTools(["workspace"], ctx());
    expect(Object.keys(tools).sort()).toEqual([
      "ws_list",
      "ws_read",
      "ws_write"
    ]);
  });

  it("builds the arc-game play tools, and no scorecard tools", () => {
    const built = buildRecipeTools(["arc-game"], ctx());
    expect(Object.keys(built.tools).sort()).toEqual([
      "arc_act",
      "arc_inspect",
      "arc_reset_game"
    ]);
  });

  it("gives a subagent no way to open or close a scorecard", () => {
    const { tools } = buildRecipeTools(["arc-game"], ctx());
    expect(tools.arc_open_scorecard).toBeUndefined();
    expect(tools.arc_close_scorecard).toBeUndefined();
    expect(tools.arc_list_scorecards).toBeUndefined();
    expect(tools.arc_list_games).toBeUndefined();
  });

  it("withholds the play tools when the type's params are missing", () => {
    // A play with no card and no game cannot succeed; offering the tools anyway
    // would let a subagent burn its whole turn budget discovering that.
    const { tools } = buildRecipeTools(["arc-game"], ctx({ params: {} }));
    expect(Object.keys(tools)).toEqual([]);
  });

  it("withholds them when only one of the two params is present", () => {
    const { tools } = buildRecipeTools(
      ["arc-game"],
      ctx({ params: { card_id: "card-1" } })
    );
    expect(Object.keys(tools)).toEqual([]);
  });

  it("supplies no abort hook — no family holds external state today", () => {
    const built = buildRecipeTools(["arc-game", "workspace"], ctx());
    expect(built.abort).toBeUndefined();
  });

  it("builds an empty toolset with no abort for no families", () => {
    const built = buildRecipeTools([], ctx({ browser: browserStub }));
    expect(Object.keys(built.tools)).toEqual([]);
    expect(built.abort).toBeUndefined();
  });
});
