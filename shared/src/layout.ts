// Canvas auto-layout, locked to images/*.png (PLAN App-C). Pure function, FR-32.
export const LAYOUT_GAP_PX = 8;

// Area a 16:9 tile occupies when letterboxed inside a w×h cell.
export function fittedTileArea(cellW: number, cellH: number): number {
  return Math.min(cellW, (cellH * 16) / 9) * Math.min(cellH, (cellW * 9) / 16);
}

const FIXED_ROWS: Record<number, number[]> = {
  3: [2, 1],
  4: [2, 2],
  5: [2, 3],
  6: [3, 3],
  7: [4, 3],
  8: [4, 4],
};

export function computeLayout(n: number, canvasW: number, canvasH: number): { rows: number[] } {
  if (n <= 0) return { rows: [] };
  if (n === 1) return { rows: [1] };
  if (n === 2) {
    const side = fittedTileArea(canvasW / 2, canvasH);
    const stacked = fittedTileArea(canvasW, canvasH / 2);
    return { rows: side >= stacked ? [2] : [1, 1] };
  }
  const fixed = FIXED_ROWS[n];
  if (fixed) return { rows: fixed };
  // n >= 9: ceil(n/4) rows, sizes as even as possible, larger rows first.
  const rowCount = Math.ceil(n / 4);
  const base = Math.floor(n / rowCount);
  let remainder = n % rowCount;
  const rows: number[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push(base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder--;
  }
  return { rows };
}
