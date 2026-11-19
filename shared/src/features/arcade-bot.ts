// Patch the Bot: a tiny robot language and its interpreter.
//
// A program is a short list of cards. The bot runs them top to bottom and loops back to the top until it
// reaches the goal, bumps a wall, or its battery runs out (every card run costs one charge).
// Five commands, nothing else:
//   fwd     move one tile forward (into a wall = crash)
//   left    turn left on the spot
//   right   turn right on the spot
//   wallL   if a wall is right in front, turn left; otherwise do nothing
//   wallR   if a wall is right in front, turn right; otherwise do nothing
// Outside the map counts as wall. Same program + same map = same run, always.
import { z } from 'zod';

export const BOT_COMMANDS = ['fwd', 'left', 'right', 'wallL', 'wallR'] as const;
export const BotCommandSchema = z.enum(BOT_COMMANDS);
export type BotCommand = z.infer<typeof BotCommandSchema>;

export const BOT_COMMAND_LABEL: Record<BotCommand, string> = {
  fwd: 'forward',
  left: 'turn left',
  right: 'turn right',
  wallL: 'wall? turn left',
  wallR: 'wall? turn right',
};

export const DIRS = ['n', 'e', 's', 'w'] as const;
export type Dir = (typeof DIRS)[number];
const STEP: Record<Dir, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

export const BotMapSchema = z.object({
  /** Rows of '.' floor, '#' wall, 'G' goal. */
  rows: z.array(z.string().regex(/^[.#G]+$/).max(8)).min(2).max(8),
  start: z.object({ x: z.number().int(), y: z.number().int(), dir: z.enum(DIRS) }),
  name: z.string().max(20),
});
export type BotMap = z.infer<typeof BotMapSchema>;

export const BotPatchSchema = z.object({ line: z.number().int().min(0).max(11), cmd: BotCommandSchema });
export type BotPatch = z.infer<typeof BotPatchSchema>;

export interface BotStep {
  /** Card that just ran. */
  pc: number;
  x: number;
  y: number;
  dir: Dir;
  /** What that card did: moved, turned, sensed nothing, or the run ended. */
  did: 'move' | 'turn' | 'noop' | 'crash' | 'goal';
}

export interface BotRun {
  ok: boolean;
  steps: BotStep[];
  /** "reached the goal in 9 steps", "bumped the wall at C3 on card 2", "battery flat after 40 cards". */
  reason: string;
  /** Card that ended it (crash), if any. */
  failPc: number | null;
}

const wallAt = (m: BotMap, x: number, y: number): boolean => {
  const row = m.rows[y];
  return row === undefined || x < 0 || x >= row.length || row[x] === '#';
};
const turn = (d: Dir, by: 1 | -1): Dir => DIRS[(DIRS.indexOf(d) + by + 4) % 4]!;
/** "B3": column letter, row number, like a board game. */
export const cellName = (x: number, y: number): string => `${String.fromCharCode(65 + x)}${y + 1}`;

export function runBot(program: BotCommand[], map: BotMap, battery: number): BotRun {
  let { x, y, dir } = map.start;
  const steps: BotStep[] = [];
  if (program.length === 0) return { ok: false, steps, reason: 'the program is empty', failPc: null };
  for (let i = 0; i < battery; i++) {
    const pc = i % program.length;
    const cmd = program[pc]!;
    const [dx, dy] = STEP[dir];
    const blocked = wallAt(map, x + dx, y + dy);
    if (cmd === 'fwd') {
      if (blocked) {
        steps.push({ pc, x, y, dir, did: 'crash' });
        return { ok: false, steps, reason: `bumped the wall next to ${cellName(x, y)} on card ${pc + 1}`, failPc: pc };
      }
      x += dx;
      y += dy;
      if (map.rows[y]?.[x] === 'G') {
        steps.push({ pc, x, y, dir, did: 'goal' });
        return { ok: true, steps, reason: `reached the goal in ${steps.length} cards`, failPc: null };
      }
      steps.push({ pc, x, y, dir, did: 'move' });
    } else if (cmd === 'left' || cmd === 'right') {
      dir = turn(dir, cmd === 'left' ? -1 : 1);
      steps.push({ pc, x, y, dir, did: 'turn' });
    } else if (blocked) {
      dir = turn(dir, cmd === 'wallL' ? -1 : 1);
      steps.push({ pc, x, y, dir, did: 'turn' });
    } else {
      steps.push({ pc, x, y, dir, did: 'noop' });
    }
  }
  return { ok: false, steps, reason: `battery went flat after ${battery} cards, still short of the goal`, failPc: null };
}

export function applyPatch(program: BotCommand[], patch: BotPatch | null): BotCommand[] {
  if (!patch) return program;
  return program.map((c, i) => (i === patch.line ? patch.cmd : c));
}

/** Every single-card change, for level design and tests. */
export function allPatches(program: BotCommand[]): BotPatch[] {
  return program.flatMap((cur, line) => BOT_COMMANDS.filter((c) => c !== cur).map((cmd) => ({ line, cmd })));
}
