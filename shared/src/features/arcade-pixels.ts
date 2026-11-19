// Rebuild the Image: parity clues over a pixel grid.
//
// The player sees a damaged picture. Every row and column has a clue: the finished picture has an odd or
// an even number of lit pixels there. Some levels add a marked group of cells with its own odd/even clue.
// A level allows at most `maxFlips` changed pixels (the number that are wrong), and hard levels also
// cap the taps (undoing a tap still costs one). For every scored level the clues and the flip limit
// leave exactly one possible repair; tests prove it with countRepairs().
import { z } from 'zod';

export const ParitySchema = z.enum(['odd', 'even']);
export type Parity = z.infer<typeof ParitySchema>;

export const PixelGroupSchema = z.object({
  cells: z.array(z.tuple([z.number().int(), z.number().int()])).min(2).max(12),
  parity: ParitySchema,
});
export type PixelGroup = z.infer<typeof PixelGroupSchema>;

/** What the phone gets: the damaged picture and the clues, never the finished picture. */
export const PixelPuzzleSchema = z.object({
  size: z.number().int().min(3).max(7),
  /** Rows of '0'/'1' as shown at the start. */
  start: z.array(z.string().regex(/^[01]+$/)),
  rows: z.array(ParitySchema),
  cols: z.array(ParitySchema),
  groups: z.array(PixelGroupSchema).max(3),
  /** Pixels you may change in the end (= how many are wrong). */
  maxFlips: z.number().int().min(1).max(8),
  /** Taps allowed, undos included; null = tap freely. */
  tapBudget: z.number().int().min(1).max(20).nullable(),
});
export type PixelPuzzle = z.infer<typeof PixelPuzzleSchema>;

export type Cell = [number, number];
export const cellKey = ([r, c]: Cell): string => `${r},${c}`;

const parityOf = (n: number): Parity => (n % 2 === 0 ? 'even' : 'odd');
const toGrid = (rows: string[]): boolean[][] => rows.map((r) => [...r].map((ch) => ch === '1'));

/** Apply taps (a cell tapped twice is back to how it was). Returns the cells that end up changed. */
export function netFlips(taps: Cell[]): Cell[] {
  const on = new Map<string, Cell>();
  for (const t of taps) {
    const k = cellKey(t);
    if (on.has(k)) on.delete(k);
    else on.set(k, t);
  }
  return [...on.values()];
}

export function applyFlips(start: string[], flips: Cell[]): boolean[][] {
  const g = toGrid(start);
  for (const [r, c] of flips) {
    const row = g[r];
    if (row && c >= 0 && c < row.length) row[c] = !row[c];
  }
  return g;
}

export interface ClueCheck {
  rows: boolean[];
  cols: boolean[];
  groups: boolean[];
  /** Every clue holds. */
  all: boolean;
}

export function checkClues(p: PixelPuzzle, grid: boolean[][]): ClueCheck {
  const rows = p.rows.map((want, r) => parityOf((grid[r] ?? []).filter(Boolean).length) === want);
  const cols = p.cols.map((want, c) => parityOf(grid.filter((row) => row[c]).length) === want);
  const groups = p.groups.map((g) => parityOf(g.cells.filter(([r, c]) => grid[r]?.[c]).length) === g.parity);
  return { rows, cols, groups, all: rows.every(Boolean) && cols.every(Boolean) && groups.every(Boolean) };
}

/** Build the public puzzle from the finished art and the pixels to break. Clues come from the art. */
export function makePixelPuzzle(art: string[], wrong: Cell[], groupCells: Cell[][], tapBudget: number | null): PixelPuzzle {
  const target = toGrid(art);
  const start = art.map((row, r) => [...row].map((ch, c) => (wrong.some(([wr, wc]) => wr === r && wc === c) ? (ch === '1' ? '0' : '1') : ch)).join(''));
  return {
    size: art.length,
    start,
    rows: target.map((row) => parityOf(row.filter(Boolean).length)),
    cols: target[0]!.map((_, c) => parityOf(target.filter((row) => row[c]).length)),
    groups: groupCells.map((cells) => ({ cells, parity: parityOf(cells.filter(([r, c]) => target[r]?.[c]).length) })),
    maxFlips: wrong.length,
    tapBudget,
  };
}

/** How many sets of at most `maxFlips` changed pixels satisfy every clue. A fair level has exactly 1. */
export function countRepairs(p: PixelPuzzle, stopAt = 2): { count: number; first: Cell[] | null } {
  const cells: Cell[] = [];
  for (let r = 0; r < p.size; r++) for (let c = 0; c < p.size; c++) cells.push([r, c]);
  let count = 0;
  let first: Cell[] | null = null;
  const pick: Cell[] = [];
  const walk = (from: number): boolean => {
    if (pick.length > 0 && checkClues(p, applyFlips(p.start, pick)).all) {
      count++;
      first ??= [...pick];
      if (count >= stopAt) return true;
    }
    if (pick.length === p.maxFlips) return false;
    for (let i = from; i < cells.length; i++) {
      pick.push(cells[i]!);
      if (walk(i + 1)) return true;
      pick.pop();
    }
    return false;
  };
  walk(0);
  return { count, first };
}
