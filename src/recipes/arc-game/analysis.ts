/**
 * Pure grid-analysis helpers for ARC-AGI-3 frames. No I/O — every function is a
 * deterministic transform of a 64×64 grid (color values 0–15), unit-tested in
 * isolation. The tool family calls these to render compact observations for the
 * model instead of dumping raw grids into context.
 *
 * Two rendering registers, deliberately kept apart:
 *
 * - **Prose** (diffs, shapes, histogram) names its colors: `blue->white` carries
 *   structure a bare `9->0` hides, and no tool input ever takes a color, so the
 *   index is never needed as an argument.
 * - **Grids** ({@link renderGrid}, {@link renderRegion}) stay one character per
 *   cell and carry a {@link renderLegend} instead. One char per cell is the only
 *   reason a 64×64 board is legible at all; a named cell would be unreadable and
 *   cost ~50× the tokens.
 */

/**
 * The ARC-AGI-3 16-color palette, index → name.
 *
 * Source: `agents/templates/multimodal.py` in `arcprize/ARC-AGI-3-Agents` (ARC
 * Prize's own agent template), which maps these indices to RGBA for multimodal
 * play. Taken from there rather than assumed, because **ARC-AGI-3's palette is
 * unrelated to ARC-AGI-1's**: here 0 is *white* and 1–5 are a greyscale ramp,
 * where the familiar ARC-AGI-1 mapping would say 0=black, 1=blue, 2=red. Note
 * that same repo carries a second, contradictory `COLOR_PALETTE` in
 * `langgraph_thinking/vision.py` — that one is incomplete and does not match the
 * engine; do not use it.
 *
 * The pairs matter to a player: 6/7 and 9/10 and 2/3 are related shades, which
 * the names convey and the indices do not.
 */
export const COLOR_NAMES = [
  "white", // 0  #FFFFFF
  "off-white", // 1  #CCCCCC
  "neutral-light", // 2  #999999
  "neutral", // 3  #666666
  "off-black", // 4  #333333
  "black", // 5  #000000
  "magenta", // 6  #E53AA3
  "magenta-light", // 7  #FF7BCC
  "red", // 8  #F93C31
  "blue", // 9  #1E93FF
  "blue-light", // 10 #88D8F1
  "yellow", // 11 #FFDC00
  "orange", // 12 #FF851B
  "maroon", // 13 #921231
  "green", // 14 #4FCC30
  "purple" // 15 #A356D6
] as const;

/** Color 0 (white) — treated as background by {@link locateComponents}. */
export const BACKGROUND_COLOR = 0;

/**
 * Name of a color index. An out-of-range value renders as `color <n>` rather
 * than throwing: a malformed frame should degrade the wording, not fail the turn.
 */
export function colorName(color: number): string {
  return COLOR_NAMES[color] ?? `color ${color}`;
}

/** The single character a color occupies in a grid render. */
function colorChar(color: number): string {
  return color >= 0 && color < 16 ? color.toString(16) : "?";
}

/** The current board: the LAST grid of a frame response's grid array. */
export function lastGrid(frame: number[][][]): number[][] {
  return frame.length === 0 ? [] : frame[frame.length - 1];
}

/**
 * Bare hex rows, one char per cell, no labels — the round-trippable **storage**
 * form, paired with {@link parseGrid}. Deliberately distinct from
 * {@link renderGrid}, which adds a legend, rulers and row collapsing and so
 * cannot be parsed back.
 */
export function serializeGrid(grid: number[][]): string {
  return grid.map((row) => row.map(colorChar).join("")).join("\n");
}

/** Inverse of {@link serializeGrid}. */
export function parseGrid(hex: string): number[][] {
  if (hex === "") return [];
  return hex
    .split("\n")
    .map((line) => [...line].map((ch) => parseInt(ch, 16) || 0));
}

export interface CellChange {
  row: number;
  col: number;
  from: number;
  to: number;
}

/** The rectangle enclosing a set of cells. */
export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface GridDiff {
  changed: number;
  /** Up to `cap` changed cells (for a compact summary of a large change). */
  cells: CellChange[];
  /** Rectangle enclosing ALL changed cells (not just the capped ones). */
  box: Box | null;
}

/** Cell-by-cell diff of two grids. `cap` bounds the returned cell list. */
export function diffGrids(
  a: number[][] | null,
  b: number[][],
  cap = 12
): GridDiff {
  if (a === null) return { changed: -1, cells: [], box: null };
  let changed = 0;
  const cells: CellChange[] = [];
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  for (let r = 0; r < b.length; r++) {
    const rowB = b[r];
    const rowA = a[r] ?? [];
    for (let c = 0; c < rowB.length; c++) {
      if (rowA[c] !== rowB[c]) {
        changed++;
        // The box spans every change, so it stays informative even when the
        // cell list is capped away to nothing.
        if (r < top) top = r;
        if (r > bottom) bottom = r;
        if (c < left) left = c;
        if (c > right) right = c;
        if (cells.length < cap) {
          cells.push({ row: r, col: c, from: rowA[c] ?? -1, to: rowB[c] });
        }
      }
    }
  }
  return {
    changed,
    cells,
    box: changed === 0 ? null : { top, left, bottom, right }
  };
}

/** `rows 3-5, cols 10-12` — or a single row/col rendered without the range. */
export function describeBox(box: Box): string {
  const rows =
    box.top === box.bottom ? `row ${box.top}` : `rows ${box.top}-${box.bottom}`;
  const cols =
    box.left === box.right
      ? `col ${box.left}`
      : `cols ${box.left}-${box.right}`;
  return `${rows}, ${cols}`;
}

/** `(3,10) blue->white` — one changed cell, colors named. */
export function describeCell(cell: CellChange): string {
  const from = cell.from < 0 ? "off-grid" : colorName(cell.from);
  return `(${cell.row},${cell.col}) ${from}->${colorName(cell.to)}`;
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

/** One 4-connected same-color region, with where it sits and how big it is. */
export interface Component extends Box {
  color: number;
  size: number;
}

export interface ComponentSummary {
  color: number;
  components: number;
  largest: number;
}

/**
 * Every 4-connected same-color region, with its bounding box, largest first.
 * Skips {@link BACKGROUND_COLOR}.
 *
 * The bounding boxes are the point: a rollup of counts alone tells the model
 * *that* there are three shapes and never *where* they are, which leaves dumping
 * the whole 64×64 grid as the only way to locate anything. The flood fill has to
 * visit every cell regardless, so tracking min/max row/col is free.
 */
export function locateComponents(grid: number[][]): Component[] {
  const rows = grid.length;
  const cols = rows === 0 ? 0 : grid[0].length;
  const seen = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false)
  );
  const found: Component[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = grid[r][c];
      if (color === BACKGROUND_COLOR || seen[r][c]) continue;
      // Flood-fill this component (iterative, 4-connectivity).
      let size = 0;
      let top = r;
      let left = c;
      let bottom = r;
      let right = c;
      const stack: Array<[number, number]> = [[r, c]];
      seen[r][c] = true;
      while (stack.length > 0) {
        const [cr, cc] = stack.pop()!;
        size++;
        if (cr < top) top = cr;
        if (cr > bottom) bottom = cr;
        if (cc < left) left = cc;
        if (cc > right) right = cc;
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
      found.push({ color, size, top, left, bottom, right });
    }
  }

  return found.sort((x, y) => y.size - x.size);
}

/**
 * Summarize components per color: how many, and the largest. Derived from
 * {@link locateComponents} so only one flood fill ever runs.
 */
export function connectedComponents(grid: number[][]): ComponentSummary[] {
  const perColor = new Map<number, { components: number; largest: number }>();
  for (const comp of locateComponents(grid)) {
    const entry = perColor.get(comp.color) ?? { components: 0, largest: 0 };
    entry.components++;
    entry.largest = Math.max(entry.largest, comp.size);
    perColor.set(comp.color, entry);
  }
  return [...perColor.entries()]
    .map(([color, v]) => ({
      color,
      components: v.components,
      largest: v.largest
    }))
    .sort((x, y) => y.components - x.components);
}

/**
 * Named components with their positions, largest first — the locational view.
 * `cap` bounds the list; anything beyond it is reported as a count so the model
 * knows the view is truncated rather than complete.
 */
export function renderShapes(grid: number[][], cap = 20): string {
  const comps = locateComponents(grid);
  if (comps.length === 0) return "no shapes (board is entirely white).";
  const lines = comps
    .slice(0, cap)
    .map(
      (s) =>
        `${colorName(s.color)}: ${describeBox(s)} (${s.size} cell${s.size === 1 ? "" : "s"})`
    );
  if (comps.length > cap) {
    lines.push(`+${comps.length - cap} more shape(s), smaller than these.`);
  }
  return lines.join("\n");
}

/** `0=white 9=blue b=yellow` — maps grid characters to names, present colors only. */
export function renderLegend(grid: number[][]): string {
  const present = colorHistogram(grid).sort((a, b) => a.color - b.color);
  return (
    "colors: " +
    present.map((h) => `${colorChar(h.color)}=${colorName(h.color)}`).join(" ")
  );
}

/**
 * A column ruler for a labeled grid: a tens-digit line marking every 10th column
 * and a tick line beneath it, both indented past the row-label gutter.
 */
function columnRuler(cols: number, gutter: number): string[] {
  let marks = "";
  let ticks = "";
  for (let c = 0; c < cols; c++) {
    if (c % 10 === 0) {
      const label = String(c);
      marks += label;
      ticks += "|";
      // The multi-char label has already consumed the next columns' slots.
      c += label.length - 1;
      for (let i = 1; i < label.length; i++) ticks += " ";
    } else {
      marks += " ";
      ticks += " ";
    }
  }
  const pad = " ".repeat(gutter);
  return [(pad + marks).trimEnd(), (pad + ticks).trimEnd()];
}

/**
 * The full board: a legend, a column ruler, then one labeled line per row —
 * with **runs of identical rows collapsed** into a single `12-31 |` band.
 *
 * Labels exist because a model cannot reliably count to column 37 across 64
 * undelimited characters; miscounting there costs a wrong click and two more
 * turns. Collapsing exploits how banded ARC boards are without run-length
 * encoding *within* a row, which would destroy the 2-D structure that this view
 * exists to convey.
 */
export function renderGrid(grid: number[][]): string {
  if (grid.length === 0) return "empty grid.";
  const rendered = grid.map((row) => row.map(colorChar).join(""));
  const cols = grid[0].length;

  // Gutter fits the widest row label, e.g. "62-63 | ".
  const widest = String(grid.length - 1).length;
  const gutter = widest * 2 + 1 + 3;

  const lines: string[] = [renderLegend(grid), ...columnRuler(cols, gutter)];
  for (let r = 0; r < rendered.length;) {
    let end = r;
    while (end + 1 < rendered.length && rendered[end + 1] === rendered[r])
      end++;
    const label = end === r ? String(r) : `${r}-${end}`;
    lines.push(`${label.padStart(gutter - 3)} | ${rendered[r]}`);
    r = end + 1;
  }
  return lines.join("\n");
}

/**
 * A localized view: a `radius`-cell square around (centerRow, centerCol), with
 * **absolute** row and column labels. The labels are what make the view usable —
 * an unlabeled block cannot be mapped back to a coordinate to click.
 *
 * The window is **clipped** on every side, never padded, which is what makes the
 * header's `cols` anchor true: character `i` of a body line is column
 * `firstCol + i`. Padding off-grid columns with spaces instead would shift that
 * mapping by up to `radius` near the left edge, and unlike {@link renderGrid}
 * this view carries no column ruler — the header is the only thing to count from.
 */
export function renderRegion(
  grid: number[][],
  centerRow: number,
  centerCol: number,
  radius = 5
): string {
  if (grid.length === 0) return "empty grid.";
  const firstRow = Math.max(0, centerRow - radius);
  const lastRow = Math.min(grid.length - 1, centerRow + radius);
  const firstCol = Math.max(0, centerCol - radius);

  const gutter = String(lastRow).length;
  const window: number[][] = [];
  const body: string[] = [];
  // Widest extent actually drawn, so the header says where the window ends as
  // well as where it starts. Each row is clipped on its own in case a frame
  // arrives ragged: that shortens a line, it never shifts one.
  let lastCol = firstCol;
  for (let r = firstRow; r <= lastRow; r++) {
    const end = Math.min(grid[r].length - 1, centerCol + radius);
    const cells = grid[r].slice(firstCol, end + 1);
    window.push(cells);
    body.push(
      `${String(r).padStart(gutter)} | ${cells.map(colorChar).join("")}`
    );
    lastCol = Math.max(lastCol, end);
  }

  return [
    renderLegend(window),
    `rows ${firstRow}-${lastRow}, cols ${firstCol}-${lastCol} ` +
      `(centered on row ${centerRow}, col ${centerCol})`,
    ...body
  ].join("\n");
}
