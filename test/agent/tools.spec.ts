import { describe, it, expect } from "vitest";
import { buildRecipeTools, buildTools, recall } from "@/agent/tools";
import type { RecallDeps, ToolFamilyContext } from "@/agent/tools";
import type { RecallIndex } from "@/agent/recall";
import type { WorkspaceHandle } from "@/subagent/workspace";
import type { QuickActionBinding } from "agents/browser";
import type { ArcGamesDeps } from "@/recipes/arc-game/game-tools";
import type { ArcClient } from "@/recipes/arc-game/client";
import type { SubtaskParams } from "@/recipes/types";
import type { SubtaskRuntime } from "@/agent/subtasks/types";

/**
 * An ARC client whose every method throws: registration assertions never run a
 * handler, and a throw makes an accidental call obvious.
 */
function arcGamesDeps(): ArcGamesDeps {
  const unused = () => {
    throw new Error("not called in registration tests");
  };
  return {
    client: {
      listGames: unused,
      openScorecard: unused,
      getGameScorecard: unused,
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

  it("adds the game catalogue when an ARC client is supplied", () => {
    const tools = buildTools({ arcGames: arcGamesDeps() });
    expect(Object.keys(tools).sort()).toEqual(["arc_list_games"]);
  });

  it("gives the main agent no scorecard tools at all", () => {
    // The card is leased by the recipe. Nothing here may open, close, or even
    // name one.
    const tools = buildTools({ arcGames: arcGamesDeps() });
    expect(tools.arc_open_scorecard).toBeUndefined();
    expect(tools.arc_close_scorecard).toBeUndefined();
    expect(tools.arc_list_scorecards).toBeUndefined();
  });

  it("never gives the main agent the tools that play a game", () => {
    const tools = buildTools({ arcGames: arcGamesDeps() });
    expect(tools.arc_reset_game).toBeUndefined();
    expect(tools.arc_act).toBeUndefined();
    expect(tools.arc_inspect).toBeUndefined();
  });

  it("adds every family's tools together", () => {
    const tools = buildTools({
      recall: recallDeps(true),
      browser: browserStub,
      arcGames: arcGamesDeps()
    });
    expect(Object.keys(tools).sort()).toEqual([
      "arc_list_games",
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
  over: {
    browser?: QuickActionBinding;
    params?: SubtaskParams;
    runtime?: SubtaskRuntime;
  } = {}
): ToolFamilyContext {
  return {
    env: { BROWSER: over.browser, ARC_API_KEY: "test-key" } as unknown as Env,
    workspace: fakeWorkspace,
    emitProgress: () => {},
    // The `arc-game` family is gated on the game its type declares plus the card
    // the parent leased, so supply both by default.
    params: over.params ?? { game_id: "ls20-abc" },
    runtime: over.runtime ?? { cardId: "card-1" }
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

  it("withholds the play tools when the type's game param is missing", () => {
    // A play with no game cannot succeed; offering the tools anyway would let a
    // subagent burn its whole turn budget discovering that.
    const { tools } = buildRecipeTools(["arc-game"], ctx({ params: {} }));
    expect(Object.keys(tools)).toEqual([]);
  });

  it("withholds them when the parent leased no card", () => {
    // A game with nowhere to record its runs is the same dead end, and reaches
    // here whenever the scorecard lease failed.
    const { tools } = buildRecipeTools(["arc-game"], ctx({ runtime: {} }));
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
