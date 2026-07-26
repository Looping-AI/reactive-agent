import { describe, it, expect } from "vitest";
import {
  COLOR_NAMES,
  colorHistogram,
  colorName,
  connectedComponents,
  describeBox,
  describeCell,
  diffGrids,
  lastGrid,
  locateComponents,
  parseGrid,
  renderGrid,
  renderLegend,
  renderRegion,
  renderShapes,
  serializeGrid
} from "@/recipes/arc-game/analysis";

/** A tiny grid for readable assertions. */
const GRID: number[][] = [
  [0, 1, 1],
  [0, 2, 1],
  [3, 3, 0]
];

describe("lastGrid", () => {
  it("returns the final grid of a frame array (the current board)", () => {
    expect(lastGrid([[[0]], [[1]], [[2]]])).toEqual([[2]]);
  });
  it("returns an empty grid for an empty frame", () => {
    expect(lastGrid([])).toEqual([]);
  });
});

describe("the palette", () => {
  /**
   * Pinned to `agents/templates/multimodal.py` in `arcprize/ARC-AGI-3-Agents`.
   * This is the one mapping in the recipe that is worse than useless if wrong —
   * a model told "red" about a green cell reasons confidently in the wrong
   * direction — and ARC-AGI-3's palette is NOT ARC-AGI-1's, so a plausible-looking
   * edit is exactly the failure to guard against.
   */
  it("matches the ARC-AGI-3 palette exactly, index for index", () => {
    expect([...COLOR_NAMES]).toEqual([
      "white",
      "off-white",
      "neutral-light",
      "neutral",
      "off-black",
      "black",
      "magenta",
      "magenta-light",
      "red",
      "blue",
      "blue-light",
      "yellow",
      "orange",
      "maroon",
      "green",
      "purple"
    ]);
  });

  it("is not the ARC-AGI-1 palette", () => {
    // The familiar mapping would put black at 0 and blue at 1. Getting this
    // backwards is the specific mistake this suite exists to catch.
    expect(colorName(0)).toBe("white");
    expect(colorName(5)).toBe("black");
  });

  it("degrades an out-of-range index instead of throwing", () => {
    expect(colorName(99)).toBe("color 99");
    expect(colorName(-1)).toBe("color -1");
  });
});

describe("serializeGrid / parseGrid", () => {
  it("renders each row as single hex digits", () => {
    expect(
      serializeGrid([
        [0, 10, 15],
        [1, 2, 3]
      ])
    ).toBe("0af\n123");
  });

  it("round-trips a full 64×64 grid", () => {
    const grid = Array.from({ length: 64 }, (_, r) =>
      Array.from({ length: 64 }, (_, c) => (r + c) % 16)
    );
    expect(parseGrid(serializeGrid(grid))).toEqual(grid);
  });

  it("round-trips an empty grid", () => {
    expect(parseGrid(serializeGrid([]))).toEqual([]);
  });
});

describe("diffGrids", () => {
  it("reports -1 changed for a null previous frame (first frame)", () => {
    expect(diffGrids(null, GRID).changed).toBe(-1);
  });

  it("counts changed cells and lists them (capped)", () => {
    const a = [
      [0, 0],
      [0, 0]
    ];
    const b = [
      [0, 1],
      [2, 0]
    ];
    const diff = diffGrids(a, b);
    expect(diff.changed).toBe(2);
    expect(diff.cells).toEqual([
      { row: 0, col: 1, from: 0, to: 1 },
      { row: 1, col: 0, from: 0, to: 2 }
    ]);
    expect(diff.box).toEqual({ top: 0, left: 0, bottom: 1, right: 1 });
  });

  it("caps the cell list while still counting all changes", () => {
    const a = Array.from({ length: 4 }, () => new Array(4).fill(0));
    const b = Array.from({ length: 4 }, () => new Array(4).fill(7));
    const diff = diffGrids(a, b, 3);
    expect(diff.changed).toBe(16);
    expect(diff.cells).toHaveLength(3);
  });

  it("boxes every change, not just the cells that fit under the cap", () => {
    const a = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const b = a.map((row) => [...row]);
    b[1][2] = 4;
    b[6][5] = 4;
    // Cap of 1 keeps only the first cell, but the box must still span both.
    const diff = diffGrids(a, b, 1);
    expect(diff.cells).toHaveLength(1);
    expect(diff.box).toEqual({ top: 1, left: 2, bottom: 6, right: 5 });
  });

  it("has no box when nothing changed", () => {
    expect(diffGrids(GRID, GRID).box).toBeNull();
  });
});

describe("describeBox", () => {
  it("names a range", () => {
    expect(describeBox({ top: 3, left: 10, bottom: 5, right: 12 })).toBe(
      "rows 3-5, cols 10-12"
    );
  });
  it("drops the range for a single row or column", () => {
    expect(describeBox({ top: 12, left: 30, bottom: 12, right: 31 })).toBe(
      "row 12, cols 30-31"
    );
    expect(describeBox({ top: 1, left: 4, bottom: 2, right: 4 })).toBe(
      "rows 1-2, col 4"
    );
  });
});

describe("describeCell", () => {
  it("names both colors", () => {
    expect(describeCell({ row: 12, col: 30, from: 9, to: 0 })).toBe(
      "(12,30) blue->white"
    );
  });
  it("marks a cell that had no previous value", () => {
    expect(describeCell({ row: 0, col: 0, from: -1, to: 11 })).toBe(
      "(0,0) off-grid->yellow"
    );
  });
});

describe("colorHistogram", () => {
  it("counts colors descending by frequency", () => {
    expect(colorHistogram(GRID)).toEqual([
      { color: 0, count: 3 },
      { color: 1, count: 3 },
      { color: 3, count: 2 },
      { color: 2, count: 1 }
    ]);
  });
});

describe("locateComponents", () => {
  it("reports the bounding box and size of each region, largest first", () => {
    // color 1 spans (0,1),(0,2),(1,2); color 3 spans (2,0),(2,1); color 2 is (1,1).
    expect(locateComponents(GRID)).toEqual([
      { color: 1, size: 3, top: 0, left: 1, bottom: 1, right: 2 },
      { color: 3, size: 2, top: 2, left: 0, bottom: 2, right: 1 },
      { color: 2, size: 1, top: 1, left: 1, bottom: 1, right: 1 }
    ]);
  });

  it("skips white as background", () => {
    expect(locateComponents(GRID).some((c) => c.color === 0)).toBe(false);
  });

  it("separates disconnected same-color regions and locates each", () => {
    const grid = [
      [1, 0, 1],
      [0, 0, 0],
      [1, 0, 1]
    ];
    const found = locateComponents(grid);
    expect(found).toHaveLength(4);
    expect(found.map((c) => [c.top, c.left])).toEqual(
      expect.arrayContaining([
        [0, 0],
        [0, 2],
        [2, 0],
        [2, 2]
      ])
    );
  });

  it("returns nothing for an all-background board", () => {
    expect(
      locateComponents([
        [0, 0],
        [0, 0]
      ])
    ).toEqual([]);
  });
});

describe("connectedComponents", () => {
  it("counts 4-connected same-color components, skipping background 0", () => {
    const summary = connectedComponents(GRID);
    const byColor = new Map(summary.map((s) => [s.color, s]));
    expect(byColor.get(1)).toEqual({ color: 1, components: 1, largest: 3 });
    expect(byColor.get(3)).toEqual({ color: 3, components: 1, largest: 2 });
    expect(byColor.get(2)).toEqual({ color: 2, components: 1, largest: 1 });
    expect(byColor.has(0)).toBe(false);
  });

  it("separates disconnected same-color regions", () => {
    const grid = [
      [1, 0, 1],
      [0, 0, 0],
      [1, 0, 1]
    ];
    const c1 = connectedComponents(grid).find((s) => s.color === 1);
    expect(c1).toEqual({ color: 1, components: 4, largest: 1 });
  });
});

describe("renderShapes", () => {
  it("names each region and says where it is", () => {
    expect(renderShapes(GRID)).toBe(
      [
        "off-white: rows 0-1, cols 1-2 (3 cells)",
        "neutral: row 2, cols 0-1 (2 cells)",
        "neutral-light: row 1, col 1 (1 cell)"
      ].join("\n")
    );
  });

  it("says so when the board is empty of shapes", () => {
    expect(
      renderShapes([
        [0, 0],
        [0, 0]
      ])
    ).toContain("no shapes");
  });

  it("caps the list and says how many it withheld", () => {
    // A checkerboard of single-cell regions, far more than the cap.
    const grid = Array.from({ length: 8 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => ((r + c) % 2 === 0 ? 9 : 0))
    );
    const out = renderShapes(grid, 5).split("\n");
    expect(out).toHaveLength(6);
    expect(out[5]).toBe("+27 more shape(s), smaller than these.");
  });
});

describe("renderLegend", () => {
  it("maps grid characters to names, ascending, present colors only", () => {
    expect(renderLegend(GRID)).toBe(
      "colors: 0=white 1=off-white 2=neutral-light 3=neutral"
    );
  });

  it("uses hex characters for colors above 9", () => {
    expect(renderLegend([[10, 11]])).toBe("colors: a=blue-light b=yellow");
  });
});

describe("renderGrid", () => {
  it("labels rows and columns and leads with a legend", () => {
    expect(renderGrid(GRID)).toBe(
      [
        "colors: 0=white 1=off-white 2=neutral-light 3=neutral",
        "      0",
        "      |",
        "  0 | 011",
        "  1 | 021",
        "  2 | 330"
      ].join("\n")
    );
  });

  it("collapses runs of identical rows into one labeled band", () => {
    const grid = Array.from({ length: 64 }, () => new Array(64).fill(5));
    const lines = renderGrid(grid).split("\n");
    // Legend + two ruler lines + a single band, instead of 64 row lines.
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe(` 0-63 | ${"5".repeat(64)}`);
  });

  it("keeps distinct rows distinct while collapsing the bands around them", () => {
    const grid = Array.from({ length: 6 }, (_, r) =>
      r === 3 ? [1, 1] : [0, 0]
    );
    const rows = renderGrid(grid)
      .split("\n")
      .slice(3)
      .map((l) => l.split(" | ")[0].trim());
    expect(rows).toEqual(["0-2", "3", "4-5"]);
  });

  it("aligns the column ruler with the grid body", () => {
    const grid = Array.from({ length: 64 }, () => new Array(64).fill(0));
    const lines = renderGrid(grid).split("\n");
    const body = lines[3];
    const gutter = body.indexOf("| ") + 2;
    // Every tick on the ruler must sit exactly over the column it labels.
    for (const col of [0, 10, 20, 30, 40, 50, 60]) {
      expect(lines[2][gutter + col]).toBe("|");
    }
    expect(lines[1].slice(gutter, gutter + 1)).toBe("0");
    expect(lines[1].slice(gutter + 10, gutter + 12)).toBe("10");
  });

  it("reports an empty grid rather than rendering nothing", () => {
    expect(renderGrid([])).toBe("empty grid.");
  });
});

describe("renderRegion", () => {
  it("labels absolute rows and columns, clipping at the edges", () => {
    // Center (row 0, col 0), radius 1 → the window wants cols -1..1 and rows
    // -1..1, and is clipped to the board on both. Nothing is padded: the first
    // character of each line is column 0, exactly as the header says.
    expect(renderRegion(GRID, 0, 0, 1)).toBe(
      [
        "colors: 0=white 1=off-white 2=neutral-light",
        "rows 0-1, cols 0-1 (centered on row 0, col 0)",
        "0 | 01",
        "1 | 02"
      ].join("\n")
    );
  });

  it("anchors the first character at the labeled column, not at the center", () => {
    // The bottom-right corner: clipped on the far side, and starting at col 1.
    // A leading pad here would make the header's `cols 1-2` a lie and send a
    // click one column off.
    expect(renderRegion(GRID, 2, 2, 1)).toBe(
      [
        "colors: 0=white 1=off-white 2=neutral-light 3=neutral",
        "rows 1-2, cols 1-2 (centered on row 2, col 2)",
        "1 | 21",
        "2 | 30"
      ].join("\n")
    );
  });

  it("labels rows with their real indices away from the origin", () => {
    const grid = Array.from({ length: 64 }, (_, r) =>
      new Array(64).fill(r % 16)
    );
    const lines = renderRegion(grid, 40, 30, 2).split("\n");
    expect(lines[1]).toBe(
      "rows 38-42, cols 28-32 (centered on row 40, col 30)"
    );
    expect(lines.slice(2).map((l) => l.split(" | ")[0])).toEqual([
      "38",
      "39",
      "40",
      "41",
      "42"
    ]);
  });

  it("reports an empty grid rather than rendering nothing", () => {
    expect(renderRegion([], 0, 0)).toBe("empty grid.");
  });
});
