// Arcade rounds: the 7-8 PM puzzle hour. Three puzzle games (Packet Panic, Patch the Bot, Rebuild the
// Image), released in rounds by the console, scored once per level, with four houses and personal
// mocktail tokens on the side. Server side lives in server/src/features/arcade (rounds.ts, levels.ts).
//
// Fairness model (also shown to players in RULES below):
//   - Levels are server data; a phone only gets a level once its round is released.
//   - Every try is checked on the server with the same deterministic engine the phone animates.
//   - A level pays once per person, ever. Replays are free practice. A retried request (same key)
//     returns the stored answer instead of trying again, so nothing can pay twice.
//   - An attempt keeps the round it started in, even if the console releases the next round mid-run.
import { z } from 'zod';
import { BotCommandSchema, BotMapSchema, BotPatchSchema, type BotStep } from './arcade-bot';
import { NetworkSchema, type PacketOutcome, type PacketPos, RoutePlanSchema } from './arcade-net';
import { type ClueCheck, PixelPuzzleSchema } from './arcade-pixels';

export const PUZZLE_IDS = ['packet', 'patch', 'pixels'] as const;
export const PuzzleIdSchema = z.enum(PUZZLE_IDS);
export type PuzzleId = z.infer<typeof PuzzleIdSchema>;

export interface PuzzleInfo {
  id: PuzzleId;
  title: string;
  blurb: string;
  /** The 15-second version: what to tap. */
  howTo: string;
}

export const PUZZLE_GAMES: Record<PuzzleId, PuzzleInfo> = {
  packet: {
    id: 'packet',
    title: 'packet panic',
    blurb: 'point the arrows, hit send, watch your packets race the wires. one jam and they miss the deadline.',
    howTo: 'tap an arrow at each junction to pick the wire, then send.',
  },
  patch: {
    id: 'patch',
    title: 'patch the bot',
    blurb: 'one card in the program is wrong. fix it so the bot reaches the goal on every test map.',
    howTo: 'tap one card, pick a new command, run the tests.',
  },
  pixels: {
    id: 'pixels',
    title: 'rebuild the image',
    blurb: 'a picture got corrupted. odd and even clues on every row and column tell you which pixels flipped.',
    howTo: 'tap pixels to flip them until every clue ticks, then check.',
  },
};

/** Rounds the console can release. Each round adds one level to each game. */
export const ROUND_COUNT = 4;
/** Points for a level by its round (1-based). */
export const LEVEL_POINTS = [4, 6, 8, 10] as const;
/** Each failed try on a scored attempt takes 1 point off, down to half the level's points. */
export const worthAfter = (base: number, fails: number): number => Math.max(Math.ceil(base / 2), base - fails);
/** Minimum gap between tries, per person (server enforced). */
export const TRY_GAP_MS = 800;

export const RULES: string[] = [
  'each round adds a fresh level to every game. old levels stay open, so you can catch up.',
  'a level pays once per person. replays are practice: no points, no tokens.',
  `level points by round: ${LEVEL_POINTS.join(', ')}. every failed try takes 1 off, never below half.`,
  "your attempt keeps the round it started in, even if the next round drops while you're playing.",
  'what you score also goes to your house. you cannot switch houses or move points.',
  'every first clear earns mocktail tokens. spending tokens never touches your score or your house.',
  'the server checks every try with the same rules you see. same plan, same result, every time.',
];

// Houses ---------------------------------------------------------------------------------------

export const HOUSE_TONES = ['tangerine', 'lime', 'sky', 'pink'] as const;
export const HouseToneSchema = z.enum(HOUSE_TONES);
export type HouseTone = z.infer<typeof HouseToneSchema>;
/** Shapes ride along with the colours so houses are never colour-only. */
export const HOUSE_GLYPHS = ['star', 'bolt', 'crown', 'flame'] as const;
export const HouseGlyphSchema = z.enum(HOUSE_GLYPHS);

export const HouseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  tone: HouseToneSchema,
  glyph: HouseGlyphSchema,
});
export type House = z.infer<typeof HouseSchema>;

export const HouseStandingSchema = HouseSchema.extend({
  members: z.number().int(),
  points: z.number().int(),
  wins: z.number().int(),
  /** points[r - 1] = what the house scored in attempts started in round r. */
  byRound: z.array(z.number().int()),
  /** Rounds this house holds an extra-hint perk for. */
  perks: z.array(z.number().int()),
  /** 1-based, ties share a rank. */
  rank: z.number().int(),
});
export type HouseStanding = z.infer<typeof HouseStandingSchema>;

export const HousesResponseSchema = z.object({ houses: z.array(HouseStandingSchema), round: z.number().int(), now: z.number() });
export type HousesResponse = z.infer<typeof HousesResponseSchema>;

// Levels -------------------------------------------------------------------------------------------

export const LevelSummarySchema = z.object({
  id: z.string(),
  game: PuzzleIdSchema,
  /** Round that released it, 1..ROUND_COUNT. */
  round: z.number().int(),
  title: z.string(),
  points: z.number().int(),
  /** new: never cleared; cleared: paid out, replays are practice. */
  status: z.enum(['new', 'cleared']),
  /** You have an attempt in progress on it. */
  inProgress: z.boolean(),
});
export type LevelSummary = z.infer<typeof LevelSummarySchema>;

export const LevelBodySchema = z.discriminatedUnion('game', [
  z.object({ game: z.literal('packet'), network: NetworkSchema }),
  z.object({ game: z.literal('patch'), program: z.array(BotCommandSchema).min(1).max(12), maps: z.array(BotMapSchema).min(1).max(3), battery: z.number().int() }),
  z.object({ game: z.literal('pixels'), puzzle: PixelPuzzleSchema }),
]);
export type LevelBody = z.infer<typeof LevelBodySchema>;

export const HintSchema = z.discriminatedUnion('game', [
  z.object({ game: z.literal('packet'), packetId: z.string(), node: z.string(), link: z.string() }),
  z.object({ game: z.literal('patch'), line: z.number().int() }),
  z.object({ game: z.literal('pixels'), cell: z.tuple([z.number().int(), z.number().int()]) }),
]);
export type Hint = z.infer<typeof HintSchema>;

export const AttemptSchema = z.object({
  id: z.string(),
  levelId: z.string(),
  game: PuzzleIdSchema,
  /** The round this attempt started in. It never changes. */
  round: z.number().int(),
  /** scored: a win pays. replay: you cleared this level before, so it's practice. */
  mode: z.enum(['scored', 'replay']),
  status: z.enum(['open', 'won']),
  tries: z.number().int(),
  fails: z.number().int(),
  /** Points a win pays right now (0 on a replay). */
  worth: z.number().int(),
  /** Points this attempt paid (after a win). */
  paid: z.number().int(),
  hint: HintSchema.nullable(),
  /** Your house has the extra-hint perk for this attempt's round and you haven't used it. */
  hintAvailable: z.boolean(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const StartAttemptRequestSchema = z.object({ levelId: z.string().min(1).max(40) });
export const StartAttemptResponseSchema = z.object({
  attempt: AttemptSchema,
  level: LevelSummarySchema,
  body: LevelBodySchema,
  /** pixels only, after a win: the finished picture. */
  reveal: z.object({ art: z.array(z.string()), name: z.string() }).nullable(),
});
export type StartAttemptResponse = z.infer<typeof StartAttemptResponseSchema>;

const CellSchema = z.tuple([z.number().int().min(0).max(7), z.number().int().min(0).max(7)]);
export const TryRequestSchema = z.object({
  /** Random per press of Send/Run/Check. Resending the same key returns the stored result. */
  key: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
  plan: z.discriminatedUnion('game', [
    z.object({ game: z.literal('packet'), routes: RoutePlanSchema }),
    z.object({ game: z.literal('patch'), patch: BotPatchSchema }),
    z.object({ game: z.literal('pixels'), taps: z.array(CellSchema).max(24) }),
  ]),
});
export type TryRequest = z.infer<typeof TryRequestSchema>;

// The outcome types are produced by the shared engines; the schemas only check the envelope.
const PacketOutcomeSchema = z.custom<{ frames: PacketPos[][]; outcomes: PacketOutcome[] }>((v) => typeof v === 'object' && v !== null && 'frames' in v);
const PatchOutcomeSchema = z.custom<{ runs: { map: number; ok: boolean; steps: BotStep[]; reason: string; failPc: number | null }[] }>(
  (v) => typeof v === 'object' && v !== null && 'runs' in v,
);
const PixelOutcomeSchema = z.custom<{ check: ClueCheck; flips: [number, number][]; reason: string }>((v) => typeof v === 'object' && v !== null && 'check' in v);

export const TryResponseSchema = z.object({
  ok: z.boolean(),
  attempt: AttemptSchema,
  /** Points this try added to your total (0 unless it was the paying win). */
  points: z.number().int(),
  /** Mocktail tokens this try earned. */
  tokens: z.number().int(),
  outcome: z.discriminatedUnion('game', [
    z.object({ game: z.literal('packet'), result: PacketOutcomeSchema }),
    z.object({ game: z.literal('patch'), result: PatchOutcomeSchema }),
    z.object({ game: z.literal('pixels'), result: PixelOutcomeSchema }),
  ]),
  reveal: z.object({ art: z.array(z.string()), name: z.string() }).nullable(),
});
export type TryResponse = z.infer<typeof TryResponseSchema>;

export const HintResponseSchema = z.object({ attempt: AttemptSchema });

// Hub ------------------------------------------------------------------------------------------------

export const RewardsSchema = z.object({
  /** Tokens from first clears, at the current rate. */
  earned: z.number().int(),
  spent: z.number().int(),
  balance: z.number().int(),
  mocktailCost: z.number().int(),
  tokensPerClear: z.number().int(),
  /** What to show at the bar. */
  kitId: z.string(),
});
export type Rewards = z.infer<typeof RewardsSchema>;

export const RoundsHubSchema = z.object({
  /** The console has the arcade open. */
  open: z.boolean(),
  round: z.number().int(),
  maxRound: z.number().int(),
  releasedAt: z.number().nullable(),
  levels: z.array(LevelSummarySchema),
  /** Points still on the table for you across released levels. */
  pointsLeft: z.number().int(),
  /** Points you earned from rounds (also on your leaderboard total). */
  pointsEarned: z.number().int(),
  house: HouseStandingSchema.nullable(),
  rewards: RewardsSchema,
  rules: z.array(z.string()),
});
export type RoundsHub = z.infer<typeof RoundsHubSchema>;

// Console ---------------------------------------------------------------------------------------------

export const ReleaseRoundRequestSchema = z.object({
  /** The round you mean to release (current + 1). A double click asks for the same round twice and gets a 409, not two rounds. */
  round: z.number().int().min(1).max(ROUND_COUNT),
});
export const PerkRequestSchema = z.object({ houseId: z.number().int(), round: z.number().int().min(1).max(ROUND_COUNT) });
export const HouseAssignRequestSchema = z.object({ houseId: z.number().int(), kitIds: z.array(z.string().trim().min(1).max(20)).min(1).max(400) });
export const HouseRenameRequestSchema = z.object({ name: z.string().trim().min(1).max(24) });
export const RewardSettingsRequestSchema = z.object({
  tokensPerClear: z.number().int().min(0).max(20).optional(),
  mocktailCost: z.number().int().min(1).max(100).optional(),
});
export const RewardSettingsSchema = z.object({ tokensPerClear: z.number().int(), mocktailCost: z.number().int() });
export type RewardSettings = z.infer<typeof RewardSettingsSchema>;
export const ClaimRequestSchema = z.object({
  kitId: z.string().trim().min(1).max(20),
  /** Random per press of the claim button: a double press or a retried request claims once. */
  key: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
});
export const RoundsResetRequestSchema = z.object({ confirm: z.literal('RESET ROUNDS') });

export const PersonLookupSchema = z.object({
  attendeeId: z.number().int(),
  kitId: z.string(),
  name: z.string().nullable(),
  nickname: z.string().nullable(),
  house: HouseSchema.nullable(),
  rewards: RewardsSchema,
  claims: z.array(z.object({ at: z.number(), tokens: z.number().int() })),
});
export type PersonLookup = z.infer<typeof PersonLookupSchema>;
export const ClaimResponseSchema = z.object({ duplicate: z.boolean(), person: PersonLookupSchema });

export const RoundsAdminSchema = z.object({
  open: z.boolean(),
  round: z.number().int(),
  maxRound: z.number().int(),
  released: z.array(z.object({ round: z.number().int(), at: z.number() })),
  houses: z.array(HouseStandingSchema),
  unassigned: z.number().int(),
  rewards: RewardSettingsSchema,
  claims: z.object({ count: z.number().int(), tokens: z.number().int() }),
  levels: z.array(z.object({ id: z.string(), game: PuzzleIdSchema, round: z.number().int(), title: z.string(), players: z.number().int(), clears: z.number().int(), tries: z.number().int() })),
});
export type RoundsAdmin = z.infer<typeof RoundsAdminSchema>;

// Live events -------------------------------------------------------------------------------------------

/** To everyone: the console released a round. Phones toast it; nobody's running attempt changes. */
export const RoundReleasedSchema = z.object({ round: z.number().int(), at: z.number(), titles: z.array(z.string()) });
export type RoundReleased = z.infer<typeof RoundReleasedSchema>;
/** To everyone: house standings moved (throttled), refetch. */
export type HousesChanged = { at: number };
/** To everyone: a house got the extra-hint perk for a round. */
export type PerkGranted = { houseId: number; house: string; round: number };

declare module '../live' {
  interface LiveEvents {
    'arcade.round': RoundReleased;
    'arcade.houses': HousesChanged;
    'arcade.perk': PerkGranted;
  }
}
