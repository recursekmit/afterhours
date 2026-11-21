// Leaderboard screens (spec 5.8). The ledger and GET /api/points/leaderboard are core; this adds the
// phone/projector board with "you are #N, X behind", the organiser freeze + dramatic top-N reveal,
// and cheap rank-change live events.
import { z } from 'zod';
import { AvatarConfigSchema } from '../avatar';

/**
 * Ranks are always unique: equal totals are ordered by who got there first (earlier last award wins,
 * then lower attendee id), which is core's rule. `tied` marks rows that share a total with a neighbour
 * so the UI can draw an "=".
 */
export const BoardRowSchema = z.discriminatedUnion('hidden', [
  z.object({
    hidden: z.literal(false),
    rank: z.number().int(),
    attendeeId: z.number().int(),
    nickname: z.string(),
    avatar: AvatarConfigSchema,
    total: z.number().int(),
    tied: z.boolean(),
  }),
  /** A rank the final reveal has not uncovered yet. No identity, no points. */
  z.object({ hidden: z.literal(true), rank: z.number().int() }),
]);
export type BoardRow = z.infer<typeof BoardRowSchema>;

export const RevealStateSchema = z.object({
  /** How many places the reveal counts down (10 = ranks 10..1). */
  topN: z.number().int(),
  /** Gap between places, and an extra beat before the very last place (rank 1). */
  stepMs: z.number().int(),
  suspenseMs: z.number().int(),
  /** Server time the reveal began, null until the organiser starts it. */
  startedAt: z.number().nullable(),
  /** How many places are uncovered right now (derived from server time). */
  revealed: z.number().int(),
  /** Server time each place uncovers: index 0 is rank topN, the last is rank 1. Null until started. */
  schedule: z.array(z.number()).nullable(),
  done: z.boolean(),
});
export type RevealState = z.infer<typeof RevealStateSchema>;

export const FreezeStateSchema = z.object({
  frozen: z.boolean(),
  frozenAt: z.number().nullable(),
  /** Frozen with the top places covered until the reveal uncovers them. */
  hideTop: z.boolean(),
  reveal: RevealStateSchema.nullable(),
});
export type FreezeState = z.infer<typeof FreezeStateSchema>;

export const MyStandingSchema = z.object({
  /** null: no points yet (or profile unfinished). */
  rank: z.number().int().nullable(),
  /** Your points as the board shows them (the frozen snapshot while frozen). */
  total: z.number().int(),
  /** Your points right now; keeps counting during a freeze. */
  liveTotal: z.number().int(),
  tied: z.boolean(),
  /** In the covered part of the top, so rank/neighbours are secret until the reveal. */
  hiddenInTop: z.boolean(),
  /** Points to catch the person above you (0 means level on points, they are ahead on who got there first). Null when #1 or unranked. */
  behind: z.number().int().nullable(),
  /** Their nickname, null when #1, unranked or still covered. */
  nextNickname: z.string().nullable(),
  /** When you are #1: how far ahead of #2. */
  lead: z.number().int().nullable(),
  /** Up to 2 rows above and 2 below you, so the phone can show your surroundings. */
  neighbours: z.array(BoardRowSchema),
});
export type MyStanding = z.infer<typeof MyStandingSchema>;

/** GET /api/leaderboard?limit=10 (attendee: with `me`; projector; console, `peek=1` unmasks). */
export const BoardResponseSchema = z.object({
  rows: z.array(BoardRowSchema),
  players: z.number().int(),
  now: z.number(),
  /** When the numbers behind this payload were taken (frozen: the freeze time). */
  asOf: z.number(),
  freeze: FreezeStateSchema,
  me: MyStandingSchema.nullable(),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

export const BoardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  peek: z.enum(['1', '0', 'true', 'false']).optional(),
});

/** POST /api/leaderboard/admin/freeze */
export const FreezeRequestSchema = z.object({
  topN: z.number().int().min(1).max(50).default(10),
  stepMs: z.number().int().min(1000).max(30_000).default(5000),
  suspenseMs: z.number().int().min(0).max(30_000).default(4000),
  hideTop: z.boolean().default(true),
});
export type FreezeRequest = z.input<typeof FreezeRequestSchema>;
/** POST /api/leaderboard/admin/reveal */
export const RevealRequestSchema = z.object({ restart: z.boolean().default(false) });
export type RevealRequest = z.input<typeof RevealRequestSchema>;

// Live events ------------------------------------------------------------

export const CompactRowSchema = z.object({
  rank: z.number().int(),
  attendeeId: z.number().int(),
  nickname: z.string(),
  avatar: AvatarConfigSchema,
  total: z.number().int(),
});
/**
 * To everyone, at most once per 2 s and only when the top 10 actually changed: the new top 10 and who moved.
 * Not sent while frozen. Drives the projector reshuffle without anyone refetching the board.
 */
export const LeaderboardMovesSchema = z.object({
  top: z.array(CompactRowSchema),
  moves: z.array(z.object({ attendeeId: z.number().int(), from: z.number().int().nullable(), to: z.number().int() })),
  players: z.number().int(),
});
export type LeaderboardMoves = z.infer<typeof LeaderboardMovesSchema>;

/** To one attendee, when their own points moved their rank. Not sent while frozen. */
export const MyRankEventSchema = z.object({
  rank: z.number().int(),
  previous: z.number().int().nullable(),
  total: z.number().int(),
  behind: z.number().int().nullable(),
  nextNickname: z.string().nullable(),
});
export type MyRankEvent = z.infer<typeof MyRankEventSchema>;

/** To everyone: freeze/unfreeze/reveal-started/reveal-reset. Refetch the board. */
export const FreezeEventSchema = FreezeStateSchema;

/** To everyone: one more place uncovered (fired by the server clock so all screens stay in step). */
export const RevealStepSchema = z.object({
  rank: z.number().int(),
  row: BoardRowSchema,
  /** Places uncovered so far, including this one. */
  revealed: z.number().int(),
  topN: z.number().int(),
  done: z.boolean(),
});
export type RevealStep = z.infer<typeof RevealStepSchema>;

/** "Still here?" (event day, prizes for the top people who are still in the room). */
export const HereMeSchema = z.object({ here: z.boolean(), at: z.number().int().nullable() });
export type HereMe = z.infer<typeof HereMeSchema>;
export const HereRowSchema = z.object({
  place: z.number().int(),
  rank: z.number().int(),
  attendeeId: z.number().int(),
  nickname: z.string(),
  roll: z.string().nullable(),
  total: z.number().int(),
  at: z.number().int(),
});
export type HereRow = z.infer<typeof HereRowSchema>;
export const HereBoardSchema = z.object({ rows: z.array(HereRowSchema), here: z.number().int(), players: z.number().int() });
export type HereBoard = z.infer<typeof HereBoardSchema>;

declare module '../live' {
  interface LiveEvents {
    'leaderboard.moves': LeaderboardMoves;
    'leaderboard.rank': MyRankEvent;
    'leaderboard.freeze': FreezeState;
    'leaderboard.reveal': RevealStep;
    'leaderboard.here': { here: number };
  }
}
