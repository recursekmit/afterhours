// The arcade-rounds level catalogue: one level per game per round, easy to brutal.
// Levels are server data: a phone only receives a level once its round is released, and it never receives
// the solution or the finished picture before a win. Solutions here are what hints reveal; tests prove every
// level is winnable, that pixel repairs are unique, and that the harder levels beat the naive approach.
import type { BotCommand, BotMap, BotPatch } from '@afterhours/shared/features/arcade-bot';
import type { Network, RoutePlan } from '@afterhours/shared/features/arcade-net';
import { type Cell, makePixelPuzzle, type PixelPuzzle } from '@afterhours/shared/features/arcade-pixels';
import { LEVEL_POINTS, type LevelBody, type PuzzleId } from '@afterhours/shared/features/arcade-rounds';

interface Base {
  id: string;
  round: number;
  title: string;
}
export type Level =
  | (Base & { game: 'packet'; network: Network; solution: RoutePlan })
  | (Base & { game: 'patch'; program: BotCommand[]; maps: BotMap[]; battery: number; solution: BotPatch; trap?: BotPatch })
  | (Base & { game: 'pixels'; puzzle: PixelPuzzle; art: string[]; artName: string; wrong: Cell[] });

const N = (id: string, kind: 'source' | 'junction' | 'server', x: number, y: number, label = id.toUpperCase()) => ({ id, kind, x, y, label });

// ---- packet panic -----------------------------------------------------------------------------------

const PACKET: Level[] = [
  {
    id: 'packet-1',
    game: 'packet',
    round: 1,
    title: 'first hop',
    // One packet, one junction, two ways out. The arrow starts unset, so pressing send blind shows a stuck packet.
    network: {
      nodes: [N('home', 'source', 10, 32), N('j1', 'junction', 46, 32), N('web', 'server', 88, 12), N('db', 'server', 88, 52)],
      links: [
        { id: 'a', from: 'home', to: 'j1' },
        { id: 'w', from: 'j1', to: 'web' },
        { id: 'd', from: 'j1', to: 'db' },
      ],
      packets: [{ id: 'A', label: 'A', from: 'home', to: 'web' }],
      deadline: 4,
    },
    solution: { A: { j1: 'w' } },
  },
  {
    id: 'packet-2',
    game: 'packet',
    round: 2,
    title: 'rush hour',
    // Both packets want the fast lane, which carries one at a time. Queueing makes B late; one of them must take the slow lane.
    network: {
      nodes: [N('home', 'source', 6, 32), N('j1', 'junction', 28, 32), N('j2', 'junction', 60, 12), N('j3', 'junction', 60, 52), N('web', 'server', 92, 12), N('db', 'server', 92, 52)],
      links: [
        { id: 'a', from: 'home', to: 'j1', capacity: 2 },
        { id: 'f', from: 'j1', to: 'j2', length: 2 },
        { id: 's', from: 'j1', to: 'j3', length: 3 },
        { id: 'w1', from: 'j2', to: 'web' },
        { id: 'd1', from: 'j2', to: 'db' },
        { id: 'w2', from: 'j3', to: 'web' },
        { id: 'd2', from: 'j3', to: 'db' },
      ],
      packets: [
        { id: 'A', label: 'A', from: 'home', to: 'web' },
        { id: 'B', label: 'B', from: 'home', to: 'db' },
      ],
      deadline: 5,
    },
    solution: { A: { j1: 'f', j2: 'w1' }, B: { j1: 's', j3: 'd2' } },
  },
  {
    id: 'packet-3',
    game: 'packet',
    round: 3,
    title: 'four lanes',
    // Four packets, a single-file crossover and two slow bypasses. The shortest path for everyone jams the middle.
    network: {
      nodes: [N('home', 'source', 6, 32), N('j1', 'junction', 32, 12), N('j2', 'junction', 32, 52), N('j3', 'junction', 62, 32), N('web', 'server', 92, 12), N('db', 'server', 92, 52)],
      links: [
        { id: 'u', from: 'home', to: 'j1', capacity: 2 },
        { id: 'l', from: 'home', to: 'j2', capacity: 2 },
        { id: 'x1', from: 'j1', to: 'j3' },
        { id: 'x2', from: 'j2', to: 'j3' },
        { id: 'w0', from: 'j1', to: 'web', length: 3 },
        { id: 'd0', from: 'j2', to: 'db', length: 3 },
        { id: 'w', from: 'j3', to: 'web' },
        { id: 'd', from: 'j3', to: 'db' },
      ],
      packets: [
        { id: 'A', label: 'A', from: 'home', to: 'web' },
        { id: 'B', label: 'B', from: 'home', to: 'web' },
        { id: 'C', label: 'C', from: 'home', to: 'db' },
        { id: 'D', label: 'D', from: 'home', to: 'db' },
      ],
      deadline: 4,
    },
    solution: { A: { home: 'u', j1: 'x1', j3: 'w' }, B: { home: 'u', j1: 'w0' }, C: { home: 'l', j2: 'x2', j3: 'd' }, D: { home: 'l', j2: 'd0' } },
  },
  {
    id: 'packet-4',
    game: 'packet',
    round: 4,
    title: 'cable cut',
    // The express wire J1 to J4 goes down at tick 2. Only the first packet can still make it; the late two must find another way.
    network: {
      nodes: [
        N('home', 'source', 6, 32),
        N('j1', 'junction', 28, 12),
        N('j2', 'junction', 28, 52),
        N('j3', 'junction', 56, 32),
        N('j4', 'junction', 74, 12),
        N('web', 'server', 94, 12),
        N('db', 'server', 94, 52),
      ],
      links: [
        { id: 'u', from: 'home', to: 'j1', capacity: 2 },
        { id: 'l', from: 'home', to: 'j2', capacity: 2 },
        { id: 'q', from: 'j1', to: 'j4', length: 2, downAt: 2 },
        { id: 'x1', from: 'j1', to: 'j3' },
        { id: 'x2', from: 'j2', to: 'j3', capacity: 2 },
        { id: 'd0', from: 'j2', to: 'db', length: 3 },
        { id: 'y', from: 'j3', to: 'j4' },
        { id: 'd', from: 'j3', to: 'db' },
        { id: 'w', from: 'j4', to: 'web', capacity: 2 },
      ],
      packets: [
        { id: 'A', label: 'A', from: 'home', to: 'web' },
        { id: 'B', label: 'B', from: 'home', to: 'web', departAt: 1 },
        { id: 'C', label: 'C', from: 'home', to: 'db' },
        { id: 'D', label: 'D', from: 'home', to: 'web', departAt: 1 },
      ],
      deadline: 6,
    },
    solution: { A: { home: 'u', j1: 'q' }, B: { home: 'l', j2: 'x2', j3: 'y' }, C: { home: 'l', j2: 'd0' }, D: { home: 'l', j2: 'x2', j3: 'y' } },
  },
];

// ---- patch the bot ------------------------------------------------------------------------------------

const PATCH: Level[] = [
  {
    id: 'patch-1',
    game: 'patch',
    round: 1,
    title: 'wrong turn',
    program: ['fwd', 'fwd', 'left', 'fwd', 'fwd'],
    battery: 12,
    maps: [{ name: 'corner', rows: ['..G', '.##', '.##'], start: { x: 0, y: 2, dir: 'n' } }],
    solution: { line: 2, cmd: 'right' },
  },
  {
    id: 'patch-2',
    game: 'patch',
    round: 2,
    title: 'two rooms',
    // Same patch, two maps: the turn has to happen when the wall shows up, not on a fixed card.
    program: ['fwd', 'left', 'fwd'],
    battery: 30,
    maps: [
      { name: 'east wing', rows: ['#####', '#....', '####G', '#####'], start: { x: 1, y: 1, dir: 'e' } },
      { name: 'north stair', rows: ['###G#', '###.#', '###.#', '###..'], start: { x: 4, y: 3, dir: 'w' } },
    ],
    solution: { line: 1, cmd: 'wallR' },
  },
  {
    id: 'patch-3',
    game: 'patch',
    round: 3,
    title: 'obvious fix',
    // Changing card 3 to "turn right" clears map 1 and crashes on the straight halls. "wall? turn right" passes all three.
    program: ['fwd', 'fwd', 'left', 'fwd', 'wallL'],
    battery: 40,
    maps: [
      { name: 'hook', rows: ['#####', '..G##', '.####', '.####'], start: { x: 0, y: 3, dir: 'n' } },
      { name: 'long hall', rows: ['#####', '#####', '....G', '#####'], start: { x: 0, y: 2, dir: 'e' } },
      { name: 'back hall', rows: ['G....', '#####', '#####', '#####'], start: { x: 4, y: 0, dir: 'w' } },
    ],
    solution: { line: 2, cmd: 'wallR' },
    trap: { line: 2, cmd: 'right' },
  },
  {
    id: 'patch-4',
    game: 'patch',
    round: 4,
    title: 'left or right',
    // Four different patches clear maps 1 and 2; only one survives map 3, where the corridor bends the other way.
    program: ['wallR', 'fwd', 'right', 'fwd'],
    battery: 40,
    maps: [
      { name: 'drop left', rows: ['#####', '###.#', '###.#', '#G..#'], start: { x: 3, y: 1, dir: 's' } },
      { name: 'runway', rows: ['....G', '#####', '#####', '#####'], start: { x: 0, y: 0, dir: 'e' } },
      { name: 'drop right', rows: ['###.#', '###.#', '###.#', '###.G'], start: { x: 3, y: 0, dir: 's' } },
    ],
    solution: { line: 2, cmd: 'wallL' },
    trap: { line: 1, cmd: 'left' },
  },
];

// ---- rebuild the image ----------------------------------------------------------------------------------

function pixels(id: string, round: number, title: string, artName: string, art: string[], wrong: Cell[], groups: Cell[][], tapBudget: number | null): Level {
  return { id, game: 'pixels', round, title, artName, art, wrong, puzzle: makePixelPuzzle(art, wrong, groups, tapBudget) };
}

const PIXELS: Level[] = [
  pixels('pixels-1', 1, 'one bad pixel', 'a smiley', ['1001', '0000', '1001', '0110'], [[2, 1]], [], null),
  pixels('pixels-2', 2, 'two out', 'a heart', ['01010', '11111', '11111', '01110', '00100'], [[1, 1], [3, 3]], [[[1, 0], [1, 1]]], null),
  pixels(
    'pixels-3',
    3,
    'robot, damaged',
    'a robot',
    ['011110', '100001', '101101', '100001', '011110', '010010'],
    [[2, 2], [2, 4], [4, 1]],
    [
      [[2, 1], [2, 2]],
      [[4, 0], [4, 1]],
    ],
    4,
  ),
  pixels(
    'pixels-4',
    4,
    'cat scan',
    'a cat',
    ['100001', '110011', '111111', '101101', '111111', '011110'],
    [[1, 2], [1, 4], [3, 1], [5, 3]],
    [
      [[1, 4], [1, 5]],
      [[3, 0], [3, 1]],
      [[1, 1], [1, 2]],
    ],
    6,
  ),
];

export const LEVELS: Level[] = [...PACKET, ...PATCH, ...PIXELS];
export const levelById = (id: string): Level | undefined => LEVELS.find((l) => l.id === id);
export const levelPoints = (l: Level): number => LEVEL_POINTS[l.round - 1] ?? LEVEL_POINTS[0];
export const levelsOf = (game: PuzzleId): Level[] => LEVELS.filter((l) => l.game === game);

/** What a phone may see once the level's round is out. */
export function levelBody(l: Level): LevelBody {
  if (l.game === 'packet') return { game: 'packet', network: l.network };
  if (l.game === 'patch') return { game: 'patch', program: l.program, maps: l.maps, battery: l.battery };
  return { game: 'pixels', puzzle: l.puzzle };
}
