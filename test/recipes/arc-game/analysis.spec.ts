import { describe, it, expect } from "vitest";
import {
  colorHistogram,
  connectedComponents,
  diffGrids,
  lastGrid,
  renderGridHex,
  renderRegion
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

describe("renderGridHex", () => {
  it("renders each row as single hex digits", () => {
    expect(
      renderGridHex([
        [0, 10, 15],
        [1, 2, 3]
      ])
    ).toBe("0af\n123");
  });

  it("handles a full 64×64 grid", () => {
    const grid = Array.from({ length: 64 }, () => new Array(64).fill(5));
    const out = renderGridHex(grid).split("\n");
    expect(out).toHaveLength(64);
    expect(out[0]).toHaveLength(64);
    expect(out[0]).toBe("5".repeat(64));
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
  });

  it("caps the cell list while still counting all changes", () => {
    const a = Array.from({ length: 4 }, () => new Array(4).fill(0));
    const b = Array.from({ length: 4 }, () => new Array(4).fill(7));
    const diff = diffGrids(a, b, 3);
    expect(diff.changed).toBe(16);
    expect(diff.cells).toHaveLength(3);
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

describe("connectedComponents", () => {
  it("counts 4-connected same-color components, skipping background 0", () => {
    const summary = connectedComponents(GRID);
    // color 1: two components — {(0,1),(0,2),(1,2)} of size 3. Actually
    // (0,1)-(0,2)-(1,2) are contiguous → one component of 3.
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

describe("renderRegion", () => {
  it("renders a padded square around a point, clipping at edges", () => {
    const out = renderRegion(GRID, 0, 0, 1);
    // Center (row 0, col 0), radius 1 → rows 0..1, cols -1..1. Column -1 is off
    // the grid (rendered as a space); columns 0,1 are the cell values.
    expect(out).toBe(" 01\n 02");
  });
});
