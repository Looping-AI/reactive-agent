/**
 * Pure grid-analysis helpers for ARC-AGI-3 frames. No I/O — every function is a
 * deterministic transform of a 64×64 grid (color values 0–15), unit-tested in
 * isolation. The tool family calls these to render compact observations for the
 * model instead of dumping raw grids into context.
 */

/** The current board: the LAST grid of a frame response's grid array. */
export function lastGrid(frame: number[][][]): number[][] {
  return frame.length === 0 ? [] : frame[frame.length - 1];
}

/** Render a grid as rows of single hex digits (0–f). Compact and diff-friendly. */
export function renderGridHex(grid: number[][]): string {
  return grid.map((row) => row.map((c) => c.toString(16)).join("")).join("\n");
}

export interface CellChange {
  row: number;
  col: number;
  from: number;
  to: number;
}

export interface GridDiff {
  changed: number;
  /** Up to `cap` changed cells (for a compact summary of a large change). */
  cells: CellChange[];
}

/** Cell-by-cell diff of two grids. `cap` bounds the returned cell list. */
export function diffGrids(
  a: number[][] | null,
  b: number[][],
  cap = 12
): GridDiff {
  if (a === null) return { changed: -1, cells: [] };
  let changed = 0;
  const cells: CellChange[] = [];
  for (let r = 0; r < b.length; r++) {
    const rowB = b[r];
    const rowA = a[r] ?? [];
    for (let c = 0; c < rowB.length; c++) {
      if (rowA[c] !== rowB[c]) {
        changed++;
        if (cells.length < cap) {
          cells.push({ row: r, col: c, from: rowA[c] ?? -1, to: rowB[c] });
        }
      }
    }
  }
  return { changed, cells };
}

/** Count of each color present, descending by count. */
export function colorHistogram(
  grid: number[][]
): Array<{ color: number; count: number }> {
  const counts = new Map<number, number>();
  for (const row of grid) {
    for (const c of row) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((x, y) => y.count - x.count);
}

export interface ComponentSummary {
  color: number;
  components: number;
  largest: number;
}

/**
 * Summarize 4-connected same-color components per color: how many, and the
 * largest. Skips color 0 (treated as background). A compact structural view for
 * the model without shipping the whole grid.
 */
export function connectedComponents(grid: number[][]): ComponentSummary[] {
  const rows = grid.length;
  const cols = rows === 0 ? 0 : grid[0].length;
  const seen = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false)
  );
  const perColor = new Map<number, { components: number; largest: number }>();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = grid[r][c];
      if (color === 0 || seen[r][c]) continue;
      // Flood-fill this component (iterative, 4-connectivity).
      let size = 0;
      const stack: Array<[number, number]> = [[r, c]];
      seen[r][c] = true;
      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        size++;
        const neighbors: Array<[number, number]> = [
          [cr - 1, cc],
          [cr + 1, cc],
          [cr, cc - 1],
          [cr, cc + 1]
        ];
        for (const [nr, nc] of neighbors) {
          if (
            nr >= 0 &&
            nr < rows &&
            nc >= 0 &&
            nc < cols &&
            !seen[nr][nc] &&
            grid[nr][nc] === color
          ) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      const entry = perColor.get(color) ?? { components: 0, largest: 0 };
      entry.components++;
      entry.largest = Math.max(entry.largest, size);
      perColor.set(color, entry);
    }
  }

  return [...perColor.entries()]
    .map(([color, v]) => ({
      color,
      components: v.components,
      largest: v.largest
    }))
    .sort((x, y) => y.components - x.components);
}

/** A localized hex view: a `radius`-cell square around (centerRow, centerCol). */
export function renderRegion(
  grid: number[][],
  centerRow: number,
  centerCol: number,
  radius = 5
): string {
  const rows: string[] = [];
  for (let r = centerRow - radius; r <= centerRow + radius; r++) {
    if (r < 0 || r >= grid.length) continue;
    let line = "";
    for (let c = centerCol - radius; c <= centerCol + radius; c++) {
      line += c < 0 || c >= grid[r].length ? " " : grid[r][c].toString(16);
    }
    rows.push(line);
  }
  return rows.join("\n");
}
