// Recap: the thing people walk away with. A personal story of the afternoon (built on the server in
// one endpoint from the points ledger plus read-only queries of each feature), the room's totals for
// the projector, sticker rarity for the sticker book, and the organiser's "recap open" switch.
import { z } from 'zod';
import { AvatarConfigSchema } from '../avatar';
import { GlyphSchema, PaletteColorSchema } from '../palette';
import { StickerDefSchema, type StickerDef } from '../stickers';

// ---------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------

/** GET /api/recap/status. Open when the console flipped it, or once the final leaderboard reveal is done. */
export const RecapStatusSchema = z.object({
  open: z.boolean(),
  /** Why it is open (null while closed). */
  reason: z.enum(['console', 'reveal']).nullable(),
  /** The console switch on its own. */
  consoleOpen: z.boolean(),
  revealDone: z.boolean(),
  /** The board is frozen for the closing (good moment for a teaser). */
  closing: z.boolean(),
});
export type RecapStatus = z.infer<typeof RecapStatusSchema>;

/** POST /api/recap/admin/open */
export const RecapOpenRequestSchema = z.object({ open: z.boolean() });
export type RecapOpenRequest = z.infer<typeof RecapOpenRequestSchema>;

// ---------------------------------------------------------------------------
// personality
// ---------------------------------------------------------------------------

export const PERSONALITY_IDS = ['decoder', 'explorer', 'speedrunner', 'crowd-pleaser', 'mystery'] as const;
export const PersonalityIdSchema = z.enum(PERSONALITY_IDS);
export type PersonalityId = z.infer<typeof PersonalityIdSchema>;

export interface PersonalityDef {
  id: PersonalityId;
  title: string;
  line: string;
  color: z.infer<typeof PaletteColorSchema>;
}

export const PERSONALITIES: Record<PersonalityId, PersonalityDef> = {
  decoder: { id: 'decoder', title: 'the decoder', line: 'dots, dashes, zero fear. you hear morse in your sleep now.', color: 'sky' },
  explorer: { id: 'explorer', title: 'the explorer', line: 'every corner, every sticker, every staircase. the campus is your map.', color: 'lime' },
  speedrunner: { id: 'speedrunner', title: 'the speedrunner', line: 'fast thumbs, faster brain. you treated the afternoon like a world record.', color: 'tangerine' },
  'crowd-pleaser': { id: 'crowd-pleaser', title: 'the crowd-pleaser', line: 'every poll, every hype tap. the room was louder because you were in it.', color: 'pink' },
  mystery: { id: 'mystery', title: 'the mystery guest', line: 'came, saw, kept it lowkey. legends do not need receipts.', color: 'grape' },
};

/** What the personality is derived from. All counts, all from the recap itself. */
export const PersonalityInputSchema = z.object({
  morseLevels: z.number().int().min(0),
  morseStamps: z.number().int().min(0),
  huntStamps: z.number().int().min(0),
  checkins: z.number().int().min(0),
  arcadeGames: z.number().int().min(0),
  arcadeLevels: z.number().int().min(0),
  quizCorrect: z.number().int().min(0),
  /** 0..100, or null when there was no one to compare with. */
  quizFasterThan: z.number().int().min(0).max(100).nullable(),
  votes: z.number().int().min(0),
  reactions: z.number().int().min(0),
});
export type PersonalityInput = z.infer<typeof PersonalityInputSchema>;

/** When two scores tie, the earlier one in this list wins. Fixed, so the same input always gives the same answer. */
export const PERSONALITY_TIE_ORDER: readonly Exclude<PersonalityId, 'mystery'>[] = ['decoder', 'explorer', 'speedrunner', 'crowd-pleaser'];

/** Weighted "how much of each did you do". Exported so the console can show the working. */
export function personalityScores(i: PersonalityInput): Record<Exclude<PersonalityId, 'mystery'>, number> {
  return {
    decoder: i.morseLevels * 3 + i.morseStamps * 3,
    explorer: i.huntStamps * 3 + i.checkins * 2,
    speedrunner: i.arcadeGames * 3 + i.arcadeLevels * 2 + i.quizCorrect + (i.quizFasterThan !== null && i.quizFasterThan >= 75 ? 4 : 0),
    'crowd-pleaser': i.votes * 2 + Math.floor(i.reactions / 5),
  };
}

/**
 * Your after hours personality: whatever you did most, weighted. Pure and deterministic:
 * ties go to PERSONALITY_TIE_ORDER, and nothing at all is "the mystery guest".
 * `runnerUp` is the next best (only when it scored), for "with a dash of the explorer".
 */
export function derivePersonality(i: PersonalityInput): { id: PersonalityId; runnerUp: PersonalityId | null; scores: Record<string, number> } {
  const scores = personalityScores(i);
  const ranked = [...PERSONALITY_TIE_ORDER].sort((a, b) => scores[b] - scores[a] || PERSONALITY_TIE_ORDER.indexOf(a) - PERSONALITY_TIE_ORDER.indexOf(b));
  const top = ranked[0]!;
  if (scores[top] <= 0) return { id: 'mystery', runnerUp: null, scores };
  const second = ranked[1];
  return { id: top, runnerUp: second && scores[second] > 0 ? second : null, scores };
}

// ---------------------------------------------------------------------------
// the personal recap
// ---------------------------------------------------------------------------

export const RecapTrailSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  kind: z.string(),
  stamps: z.number().int(),
  /** Stops on the trail (on a graph trail you only walk one path, so this is an upper bound). */
  stops: z.number().int(),
  finished: z.boolean(),
  graph: z.boolean(),
  /** Stop titles in the order you solved them. */
  path: z.array(z.string()),
  /** "lab" for "you went the lab way". Graph trails only, null if you never left the start. */
  way: z.string().nullable(),
});
export type RecapTrail = z.infer<typeof RecapTrailSchema>;

export const RecapArcadeBestSchema = z.object({
  game: z.string(),
  title: z.string(),
  label: z.string(),
  rank: z.number().int(),
  players: z.number().int(),
});

export const RecapSchema = z.object({
  attendee: z.object({ id: z.number().int(), nickname: z.string(), avatar: AvatarConfigSchema }),
  generatedAt: z.number(),
  arrival: z.object({
    /** First sign-in (epoch ms): "you showed up at 2:07 pm". */
    at: z.number(),
    /** 1-based: "#57 through the door". */
    order: z.number().int(),
    of: z.number().int(),
  }),
  sessions: z.object({ count: z.number().int(), titles: z.array(z.string()) }),
  polls: z.object({
    votes: z.number().int(),
    quiz: z.object({
      answered: z.number().int(),
      correct: z.number().int(),
      points: z.number().int(),
      /** Rank on quiz points among everyone who scored any. */
      rank: z.number().int().nullable(),
      players: z.number().int(),
      /** "faster than 82% of the room" (0..100), across your quiz answers. */
      fasterThan: z.number().int().nullable(),
    }),
  }),
  trails: z.object({
    stamps: z.number().int(),
    bonuses: z.number().int(),
    list: z.array(RecapTrailSchema),
  }),
  morse: z.object({
    levels: z.number().int(),
    decodeLevels: z.number().int(),
    encodeLevels: z.number().int(),
    bestWpm: z.number().nullable(),
    /** Stamps from morse trails (objects around the venue). */
    trailStamps: z.number().int(),
  }),
  arcade: z.object({
    bests: z.array(RecapArcadeBestSchema),
    levelsCleared: z.number().int(),
  }),
  reactions: z.number().int(),
  stickers: z.object({
    count: z.number().int(),
    total: z.number().int(),
    /** The rarest sticker you have, with the share of attendees who have it. */
    rarest: z.object({ sticker: StickerDefSchema, pct: z.number() }).nullable(),
    /** Most recent first, up to 6. */
    recent: z.array(StickerDefSchema),
  }),
  standing: z.object({
    rank: z.number().int().nullable(),
    total: z.number().int(),
    players: z.number().int(),
  }),
  /** The biggest single award you got. */
  topMoment: z.object({ label: z.string(), points: z.number().int(), at: z.number(), source: z.string() }).nullable(),
  personality: z.object({
    id: PersonalityIdSchema,
    runnerUp: PersonalityIdSchema.nullable(),
    scores: z.record(z.string(), z.number()),
  }),
});
export type Recap = z.infer<typeof RecapSchema>;

/** POST /api/recap/me/seen, /shared, /slaps: little secret stickers for playing with the recap itself. */
export const RecapSlapsRequestSchema = z.object({ count: z.number().int().min(1).max(10_000) });
export const RecapSeenRequestSchema = z.object({ cards: z.number().int().min(1).max(50) });

// ---------------------------------------------------------------------------
// rarity + room
// ---------------------------------------------------------------------------

/** GET /api/recap/rarity: how many attendees hold each sticker. pct = count / attendees. */
export const StickerRaritySchema = z.object({
  attendees: z.number().int(),
  counts: z.record(z.string(), z.number().int()),
  at: z.number(),
});
export type StickerRarity = z.infer<typeof StickerRaritySchema>;

/** Share of attendees holding a sticker, 0..100 with one decimal under 10%. */
export function rarityPct(r: Pick<StickerRarity, 'attendees' | 'counts'>, stickerId: string): number {
  if (r.attendees <= 0) return 0;
  const pct = ((r.counts[stickerId] ?? 0) / r.attendees) * 100;
  return pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
}

export const RoomHolderSchema = z.object({ nickname: z.string(), avatar: AvatarConfigSchema });

/** GET /api/recap/room (projector + console): the whole room's afternoon. */
export const RoomRecapSchema = z.object({
  attendees: z.number().int(),
  stamps: z.number().int(),
  morseLetters: z.number().int(),
  votes: z.number().int(),
  reactions: z.number().int(),
  checkins: z.number().int(),
  stickers: z.number().int(),
  points: z.number().int(),
  rarest: z
    .object({
      sticker: StickerDefSchema,
      count: z.number().int(),
      pct: z.number(),
      holders: z.array(RoomHolderSchema),
    })
    .nullable(),
  at: z.number(),
});
export type RoomRecap = z.infer<typeof RoomRecapSchema>;

/** GET /api/recap/admin/attendees?q= : pick someone to preview. */
export const RecapAttendeeListSchema = z.object({
  attendees: z.array(z.object({ id: z.number().int(), kitId: z.string(), nickname: z.string().nullable(), total: z.number().int() })),
});
export type RecapAttendeeList = z.infer<typeof RecapAttendeeListSchema>;
export const RecapAttendeeQuerySchema = z.object({ q: z.string().max(40).default('') });

// ---------------------------------------------------------------------------
// sticker book categories
// ---------------------------------------------------------------------------

export const STICKER_CATEGORIES = ['attendance', 'polls', 'trails', 'morse', 'arcade', 'secret'] as const;
export type StickerCategory = (typeof STICKER_CATEGORIES)[number];

export const STICKER_CATEGORY_INFO: Record<StickerCategory, { title: string; blurb: string; color: z.infer<typeof PaletteColorSchema>; glyph: z.infer<typeof GlyphSchema> }> = {
  attendance: { title: 'showing up', blurb: 'doors, check-ins, being in the room.', color: 'lime', glyph: 'check' },
  polls: { title: 'polls + quiz', blurb: 'opinions, fast fingers, big brain.', color: 'pink', glyph: 'spark' },
  trails: { title: 'trails', blurb: 'stamps from the hunt and the morse trails.', color: 'tangerine', glyph: 'map' },
  morse: { title: 'morse', blurb: 'dit dit dah. the online challenge.', color: 'sky', glyph: 'wave' },
  arcade: { title: 'arcade', blurb: 'high scores and cracked levels.', color: 'sun', glyph: 'bolt' },
  secret: { title: 'secret', blurb: 'nobody tells you how to get these.', color: 'grape', glyph: 'ghost' },
};

/** Which page of the book a sticker lives on. Unknown features go to secret. */
export function stickerCategory(def: Pick<StickerDef, 'id' | 'feature'>): StickerCategory {
  switch (def.feature) {
    case 'core':
    case 'attendance':
      return 'attendance';
    case 'polls':
      return 'polls';
    case 'hunt':
      return 'trails';
    case 'morse':
      return 'morse';
    case 'arcade':
      return 'arcade';
    default:
      return 'secret';
  }
}

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------

declare module '../live' {
  interface LiveEvents {
    /** To everyone: the console flipped "recap open" (or the reveal finished). Refetch status. */
    'recap.status': RecapStatus;
  }
}
