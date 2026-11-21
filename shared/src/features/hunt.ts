// Treasure hunt (spec 5.5): individual hunt, shuffled order per attendee.
//
// Rules the contract encodes:
// - The client only ever sees ITS current stop's clue and ITS solved stops.
//   Answers, tokens, other clues never appear in an attendee response.
// - A stop is solved by scanning its sticker (a QR carrying a random per-stop
//   token, or the short code printed under it) or by typing an answer.
// - Hint costs and the finish bonus are decided on the server.
import { z } from 'zod';
import { AvatarConfigSchema } from '../avatar';
import { GlyphSchema, PaletteColorSchema } from '../palette';
import { SLIP_TICKETS } from '../morse-slip';
import { MORSE_TABLE, MorseSignalSchema, wordToPatterns } from './morse';

// ---- trails ------------------------------------------------------------------
// A trail is one sequence of stops with its own state, order, points and finish
// order. The treasure hunt is trail 1; a Morse trail (objects around the venue
// carrying Morse messages) is another; organisers can add more from the console.

export const TREASURE_TRAIL_ID = 1;
export const TRAIL_KINDS = ['hunt', 'morse', 'other'] as const;
export const TrailKindSchema = z.enum(TRAIL_KINDS);
export type TrailKind = z.infer<typeof TrailKindSchema>;
/** shuffled: per-attendee order with the same final stop for everyone. fixed: authoring order for all. */
/** graph: stops connect through exits and slip outcomes; each person's path is their own. */
export const TrailOrderModeSchema = z.enum(['shuffled', 'fixed', 'graph']);
export type TrailOrderMode = z.infer<typeof TrailOrderModeSchema>;

/** How a stop is verified. */
export const HUNT_CHALLENGES = ['riddle', 'scan', 'morse', 'slip'] as const;
export const HuntChallengeSchema = z.enum(HUNT_CHALLENGES);
export type HuntChallenge = z.infer<typeof HuntChallengeSchema>;

/** Online fallback for a Morse stop plays at this speed (words per minute). */
export const TRAIL_MORSE_WPM = 8;

/** The word as Morse can carry it: upper case letters and digits only. */
export function morseWordOf(word: string): string {
  return word.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when the word has at least one character and every character has a Morse code. */
export function isMorseWord(word: string): boolean {
  const w = morseWordOf(word);
  return w.length > 0 && [...w].every((c) => MORSE_TABLE[c] !== undefined);
}

/** Dots and dashes per letter, for a printable Morse card. */
export function morseCardPatterns(word: string): string[] {
  return wordToPatterns(morseWordOf(word));
}

export const TrailSettingsSchema = z.object({
  id: z.number().int(),
  position: z.number().int(),
  kind: TrailKindSchema,
  title: z.string(),
  status: z.enum(['draft', 'open', 'closed']),
  orderMode: TrailOrderModeSchema,
  hintsOn: z.boolean(),
  cooldownOn: z.boolean(),
  /**
   * Linear trails only: each player gets this many of the stops before the finale (picked and ordered
   * per attendee from the trail's seed), then the finale everyone shares. 0 = everyone gets every stop.
   */
  subsetK: z.number().int().min(0).default(0),
  openedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
});
export type TrailSettings = z.infer<typeof TrailSettingsSchema>;

// ---- constants (shared so the UI can show them; the server enforces them) ----

export const HUNT_MAX_HINTS = 2;
/** Points a hint takes off the stop's reward, by hint number (1, 2). The stop never pays less than 1. */
export const HUNT_HINT_COSTS = [2, 3] as const;
export const HUNT_CONFIRM_RESET = 'RESET HUNT';

// ---- helpers both sides use ----

/** What a typed answer is compared as: case, spaces, accents and punctuation do not matter. "Hello, World!" == "helloworld". */
export function normaliseAnswer(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** URL a sticker's QR encodes. The web app routes /hunt/s/:token to the scanner flow. */
export function huntScanUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/hunt/s/${token}`;
}

/**
 * Whatever the camera or the typed-code box produced -> the bare token/code.
 * Accepts the full sticker URL, a bare token, or a code like "abcd-efgh".
 */
export function extractHuntCode(input: string): string {
  let s = input.trim();
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (s.includes('/')) s = s.split('/').filter(Boolean).pop() ?? '';
  return s;
}

/** Short code format printed under the QR: XXXX-XXXX. */
export function formatHuntCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// ---- attendee side ----

export const HuntStatusSchema = z.enum(['draft', 'open', 'closed']);
export type HuntStatus = z.infer<typeof HuntStatusSchema>;

export const HuntSolvedStopSchema = z.object({
  stopId: z.number().int(),
  /** 1-based position in THIS attendee's order. */
  index: z.number().int(),
  title: z.string(),
  /** The fun fact / payoff shown after solving. */
  reveal: z.string(),
  /** Stamp art for the passport. */
  glyph: GlyphSchema,
  color: PaletteColorSchema,
  solvedAt: z.number(),
  via: z.enum(['qr', 'answer']),
  /** Points this stop actually paid (after hint costs). */
  points: z.number().int(),
  hintsUsed: z.number().int(),
  /** How many people (including you) have found this stop so far. */
  solvedBy: z.number().int(),
});
export type HuntSolvedStop = z.infer<typeof HuntSolvedStopSchema>;

export const HuntCurrentStopSchema = z.object({
  /** How this stop is verified (riddle, scan, morse). */
  challenge: HuntChallengeSchema,
  /** The object's QR must be scanned before typing; true until it is. */
  needsScan: z.boolean(),
  /** Morse stop: letters in the hidden word (the UI draws that many boxes). */
  letters: z.number().int().nullable(),
  /** Morse stop with online fallback: what to play/flash. Never the readable word. */
  signal: MorseSignalSchema.nullable(),
  /**
   * Slip stop: which slip from your kit to scan. Never its readings. `unique`: every printed copy has its
   * own words and the first scan claims it; `serial` is the copy you claimed (null until you have).
   */
  slip: z.object({ slipNo: z.number().int(), label: z.string(), unique: z.boolean().default(false), serial: z.number().int().nullable().default(null) }).nullable(),
  stopId: z.number().int(),
  index: z.number().int(),
  total: z.number().int(),
  clue: z.string(),
  clueImage: z.string().nullable(),
  /** Only the hints you already revealed. */
  hints: z.array(z.string()),
  hintsLeft: z.number().int(),
  /** Cost of the next hint, null when there are none left. */
  nextHintCost: z.number().int().nullable(),
  /** What solving it right now pays. Drops as you reveal hints. */
  worth: z.number().int(),
  /** False for sticker-only stops: the UI hides the answer box. */
  canType: z.boolean(),
  /** Epoch ms until which typed answers are refused (0 when free). */
  lockedUntil: z.number(),
  wrongCount: z.number().int(),
  /** How many OTHER people are on this same stop right now. */
  hereNow: z.number().int(),
  isFinal: z.boolean(),
});
export type HuntCurrentStop = z.infer<typeof HuntCurrentStopSchema>;

/** Anonymous crowd counts, safe for everyone to see. */
export const HuntCrowdSchema = z.object({
  trailId: z.number().int(),
  /** People currently ON each stop (stop id -> count). Only stops with someone on them. */
  here: z.array(z.object({ stopId: z.number().int(), count: z.number().int() })),
  /** Started and not finished. */
  hunting: z.number().int(),
  finished: z.number().int(),
  /** Everyone who pressed start. */
  players: z.number().int(),
  updatedAt: z.number(),
});
export type HuntCrowd = z.infer<typeof HuntCrowdSchema>;

export const HuntFinisherSchema = z.object({
  rank: z.number().int(),
  attendeeId: z.number().int(),
  nickname: z.string(),
  avatar: AvatarConfigSchema,
  finishedAt: z.number(),
  elapsedMs: z.number().int(),
  /** Rank bonus + speed bonus. */
  bonus: z.number().int(),
});
export type HuntFinisher = z.infer<typeof HuntFinisherSchema>;

export const HuntMyFinishSchema = z.object({
  rank: z.number().int(),
  finishedAt: z.number(),
  elapsedMs: z.number().int(),
  rankBonus: z.number().int(),
  speedBonus: z.number().int(),
  /** Hunters who finished (so far), you included. */
  finishers: z.number().int(),
  usedNoHints: z.boolean(),
});
export type HuntMyFinish = z.infer<typeof HuntMyFinishSchema>;

/** GET /api/hunt (attendee): everything the passport screen needs. */
export const HuntMeSchema = z.object({
  trailId: z.number().int(),
  kind: TrailKindSchema,
  orderMode: TrailOrderModeSchema,
  hintsOn: z.boolean(),
  status: HuntStatusSchema,
  title: z.string(),
  total: z.number().int(),
  serverNow: z.number(),
  started: z.boolean(),
  startedAt: z.number().nullable(),
  /** Stamps collected, in the order you got them. */
  solved: z.array(HuntSolvedStopSchema),
  /** Null before you start, once you finish, and whenever the hunt is not open. */
  current: HuntCurrentStopSchema.nullable(),
  finish: HuntMyFinishSchema.nullable(),
  /** All hunt points so far (stamps + bonuses). */
  pointsEarned: z.number().int(),
  crowd: HuntCrowdSchema,
});
export type HuntMe = z.infer<typeof HuntMeSchema>;

/** POST /api/hunt/scan */
export const HuntScanRequestSchema = z.object({
  /** The QR contents (URL), the bare token, or the typed short code. */
  code: z.string().min(1).max(300),
});
export type HuntScanRequest = z.infer<typeof HuntScanRequestSchema>;

/** POST /api/hunt/answer */
export const HuntAnswerRequestSchema = z.object({
  stopId: z.number().int(),
  answer: z.string().max(120),
});
export type HuntAnswerRequest = z.infer<typeof HuntAnswerRequestSchema>;

/** POST /api/hunt/hint. `n` must be the next unrevealed hint (1 or 2); repeating a revealed one is free. */
export const HuntHintRequestSchema = z.object({
  stopId: z.number().int(),
  n: z.number().int().min(1).max(HUNT_MAX_HINTS),
});
export type HuntHintRequest = z.infer<typeof HuntHintRequestSchema>;

/**
 * Scan and answer both answer 200 with one of these (wrong answers are normal, not errors).
 * Errors (not open, not started, rate limited, bad input) use the shared error shape.
 */
export const HuntAttemptResultSchema = z.discriminatedUnion('result', [
  /** Scanned the object of a require-scan stop: the answer box is open now. */
  z.object({ result: z.literal('unlocked'), message: z.string(), stopId: z.number().int(), me: HuntMeSchema }),
  z.object({
    result: z.literal('solved'),
    message: z.string(),
    stop: HuntSolvedStopSchema,
    /** Present when this stamp completed the hunt. */
    finish: HuntMyFinishSchema.nullable(),
    me: HuntMeSchema,
  }),
  z.object({
    result: z.literal('wrong'),
    message: z.string(),
    wrongCount: z.number().int(),
    lockedUntil: z.number(),
    cooldownMs: z.number().int(),
    me: HuntMeSchema,
  }),
  z.object({
    result: z.literal('locked'),
    message: z.string(),
    lockedUntil: z.number(),
    retryAfterMs: z.number().int(),
    me: HuntMeSchema,
  }),
  /** A sticker or stop that is not your current one. Same reply for unknown and for later stops: nothing leaks. */
  z.object({ result: z.literal('not_yours'), message: z.string(), me: HuntMeSchema }),
  /** A stop you already stamped. */
  z.object({ result: z.literal('already'), message: z.string(), me: HuntMeSchema }),
]);
export type HuntAttemptResult = z.infer<typeof HuntAttemptResultSchema>;

export const HuntHintResultSchema = z.object({
  n: z.number().int(),
  hint: z.string(),
  /** Points taken off this stop's reward by this hint (0 when it was already revealed). */
  cost: z.number().int(),
  me: HuntMeSchema,
});
export type HuntHintResult = z.infer<typeof HuntHintResultSchema>;

/** GET /api/hunt/board (attendee, projector, console): the live crowd and finishers. */
export const HuntBoardSchema = z.object({
  trailId: z.number().int(),
  status: HuntStatusSchema,
  title: z.string(),
  total: z.number().int(),
  crowd: HuntCrowdSchema,
  /** Fastest first. */
  finishers: z.array(HuntFinisherSchema),
  serverNow: z.number(),
});
export type HuntBoard = z.infer<typeof HuntBoardSchema>;

// ---- console side ----

const StopTextFields = {
  /** Default: riddle when there are answers, scan when there are none. */
  challenge: HuntChallengeSchema.optional(),
  requireScan: z.boolean().default(false),
  /** Morse stops only: let the phone play/flash the Morse itself (no physical object, or remote play). */
  onlineFallback: z.boolean().default(false),
  /** Slip stops: the slip whose readings decide what happens. */
  slipId: z.number().int().nullable().default(null),
  /** Graph trails: where a riddle/scan/morse stop leads once stamped. */
  nextStopId: z.number().int().nullable().default(null),
  /** Graph trails: stamping this stop finishes the trail. */
  finale: z.boolean().default(false),
  title: z.string().trim().min(1).max(60),
  clue: z.string().trim().min(1).max(400),
  /** Relative path or https URL. */
  clueImage: z
    .string()
    .trim()
    .max(300)
    .regex(/^(https:\/\/|\/)/, 'Use an https:// link or a /path')
    .nullable()
    .default(null),
  /** Accepted typed answers (any one of them). Empty = sticker only. */
  answers: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
  hints: z.array(z.string().trim().min(1).max(200)).max(HUNT_MAX_HINTS).default([]),
  points: z.number().int().min(1).max(50).default(10),
  glyph: GlyphSchema.default('star'),
  color: PaletteColorSchema.default('tangerine'),
  /** Shown after solving. */
  reveal: z.string().trim().max(240).default(''),
  /** Organiser note: where the sticker goes. Never sent to attendees. */
  location: z.string().trim().max(120).default(''),
};
export const HuntStopInputSchema = z.object(StopTextFields);
export type HuntStopInput = z.input<typeof HuntStopInputSchema>;

export const HuntAdminStopSchema = z.object({
  trailId: z.number().int(),
  challenge: HuntChallengeSchema,
  requireScan: z.boolean(),
  onlineFallback: z.boolean(),
  slipId: z.number().int().nullable(),
  nextStopId: z.number().int().nullable(),
  finale: z.boolean(),
  id: z.number().int(),
  position: z.number().int(),
  /** The last stop in order is the finale, the same for everyone. */
  isFinal: z.boolean(),
  title: z.string(),
  clue: z.string(),
  clueImage: z.string().nullable(),
  answers: z.array(z.string()),
  hints: z.array(z.string()),
  points: z.number().int(),
  glyph: GlyphSchema,
  color: PaletteColorSchema,
  reveal: z.string(),
  location: z.string(),
  token: z.string(),
  /** Short typed code, XXXX-XXXX. */
  code: z.string(),
  url: z.string(),
  solvedBy: z.number().int(),
  hereNow: z.number().int(),
});
export type HuntAdminStop = z.infer<typeof HuntAdminStopSchema>;

/** GET /api/hunt/admin */
export const HuntAdminSchema = z.object({
  trail: TrailSettingsSchema,
  status: HuntStatusSchema,
  title: z.string(),
  openedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
  stops: z.array(HuntAdminStopSchema),
  players: z.number().int(),
  finished: z.number().int(),
  /** True once anyone pressed start: adding, deleting and reordering stops needs a reset first. */
  structureLocked: z.boolean(),
  serverNow: z.number(),
});
export type HuntAdmin = z.infer<typeof HuntAdminSchema>;

/** PUT /api/hunt/admin/state */
export const HuntAdminStateRequestSchema = z
  .object({ status: HuntStatusSchema, title: z.string().trim().min(1).max(60) })
  .partial()
  .refine((v) => v.status !== undefined || v.title !== undefined, 'Nothing to change');
export type HuntAdminStateRequest = z.infer<typeof HuntAdminStateRequestSchema>;

/** PUT /api/hunt/admin/order: every stop id, in the new order (the last one is the finale). */
export const HuntAdminOrderRequestSchema = z.object({ ids: z.array(z.number().int()).min(1).max(40) });
export type HuntAdminOrderRequest = z.infer<typeof HuntAdminOrderRequestSchema>;

/** GET /api/hunt/admin/stickers: render these as QR stickers (url -> QR, code printed under it). */
export const HuntStickerSheetSchema = z.object({
  title: z.string(),
  stops: z.array(
    z.object({
      stopId: z.number().int(),
      position: z.number().int(),
      title: z.string(),
      location: z.string(),
      token: z.string(),
      code: z.string(),
      url: z.string(),
    }),
  ),
});
export type HuntStickerSheet = z.infer<typeof HuntStickerSheetSchema>;

/** GET /api/hunt/admin/progress */
export const HuntAdminProgressSchema = z.object({
  total: z.number().int(),
  rows: z.array(
    z.object({
      attendeeId: z.number().int(),
      nickname: z.string().nullable(),
      avatar: AvatarConfigSchema.nullable(),
      name: z.string().nullable(),
      roll: z.string().nullable(),
      solved: z.number().int(),
      currentStopId: z.number().int().nullable(),
      currentStopTitle: z.string().nullable(),
      hintsUsed: z.number().int(),
      startedAt: z.number(),
      lastActiveAt: z.number(),
      finishedAt: z.number().nullable(),
      rank: z.number().int().nullable(),
      elapsedMs: z.number().int().nullable(),
    }),
  ),
  /** People on each stop right now, with the stop's title. */
  crowd: z.array(z.object({ stopId: z.number().int(), title: z.string(), count: z.number().int() })),
});
export type HuntAdminProgress = z.infer<typeof HuntAdminProgressSchema>;

/** POST /api/hunt/admin/reset */
export const HuntAdminResetRequestSchema = z.object({ confirm: z.literal(HUNT_CONFIRM_RESET) });

// ---- live events ----

export const HuntStateEventSchema = z.object({ trailId: z.number().int(), status: HuntStatusSchema, title: z.string(), total: z.number().int() });
export type HuntStateEvent = z.infer<typeof HuntStateEventSchema>;

export const HuntStampEventSchema = z.object({
  trailId: z.number().int(),
  nickname: z.string(),
  avatar: AvatarConfigSchema,
  solved: z.number().int(),
  total: z.number().int(),
  at: z.number(),
});
export type HuntStampEvent = z.infer<typeof HuntStampEventSchema>;

export const HuntFinishedEventSchema = z.object({
  trailId: z.number().int(),
  finisher: HuntFinisherSchema,
  finishedCount: z.number().int(),
});
export type HuntFinishedEvent = z.infer<typeof HuntFinishedEventSchema>;

declare module '../live' {
  interface LiveEvents {
    /** To everyone: the hunt opened, closed, was renamed or its stop count changed. Refetch GET /api/hunt. */
    'hunt.state': HuntStateEvent;
    /** To everyone: anonymous "where is the crowd" counts. Throttled (about every 1.5 s) and only sent when something moved. */
    'hunt.crowd': HuntCrowd;
    /** To screens and the console: someone collected a stamp (projector ticker). */
    'hunt.stamp': HuntStampEvent;
    /** To everyone: someone just finished. Drives the "first finishers" live moment. */
    'hunt.finished': HuntFinishedEvent;
    /** To everyone: the console turned "show trails to players" on or off. */
    'hunt.visibility': HuntVisibility;
  }
}

/**
 * GET /api/hunt/visibility (anyone), PUT /api/hunt/admin/visibility (console, either field): one switch per
 * event, both off by default. `hunt`: "show treasure hunt to players" (trails of kind hunt and other).
 * `morse`: "show morse challenge to players" (trails of kind morse, e.g. the morse slip). While off, attendees
 * see nothing of that event and its attendee APIs answer 403 not_open. The online Morse ladder has its own switch.
 */
export const HuntVisibilitySchema = z.object({ hunt: z.boolean(), morse: z.boolean() });
export type HuntVisibility = z.infer<typeof HuntVisibilitySchema>;
export const HuntVisibilityPatchSchema = HuntVisibilitySchema.partial().refine((v) => v.hunt !== undefined || v.morse !== undefined, 'Nothing to change');

/** Which event a trail belongs to: the treasure hunt (hunt, other) or the Morse challenge (morse). */
export type TrailGroup = 'hunt' | 'morse';
export const trailGroupOf = (kind: TrailKind): TrailGroup => (kind === 'morse' ? 'morse' : 'hunt');
/** Where a trail lives on the phone: Morse trails under the Morse tab, the rest under the treasure hunt. */
export const trailPath = (t: { kind: TrailKind; id: number }): string => (t.kind === 'morse' ? `/morse/t/${t.id}` : `/hunt/t/${t.id}`);

/** POST /api/hunt/admin/morse-slip: create the standalone morse slip (idempotent). */
export const MorseSlipSetupSchema = z.object({ trailId: z.number().int(), setId: z.number().int(), created: z.boolean() });
export type MorseSlipSetup = z.infer<typeof MorseSlipSetupSchema>;

// ---- trails: lists, console --------------------------------------------------

/** GET /api/hunt/trails (attendee): the trails you can play, with your progress. */
export const TrailSummarySchema = z.object({
  id: z.number().int(),
  kind: TrailKindSchema,
  title: z.string(),
  status: HuntStatusSchema,
  total: z.number().int(),
  started: z.boolean(),
  solved: z.number().int(),
  finishedRank: z.number().int().nullable(),
  hunting: z.number().int(),
  finished: z.number().int(),
});
export type TrailSummary = z.infer<typeof TrailSummarySchema>;
export const TrailListSchema = z.object({ trails: z.array(TrailSummarySchema), serverNow: z.number() });
export type TrailList = z.infer<typeof TrailListSchema>;

/** POST /api/hunt/admin/trails */
export const TrailCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(60),
  kind: TrailKindSchema.default('other'),
  orderMode: TrailOrderModeSchema.default('shuffled'),
  hintsOn: z.boolean().default(true),
  cooldownOn: z.boolean().default(true),
  subsetK: z.number().int().min(0).max(50).default(0),
});
export type TrailCreateRequest = z.input<typeof TrailCreateRequestSchema>;
/** PUT /api/hunt/admin/trails/:id (open/close goes through PUT /admin/state?trail=) */
export const TrailUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    kind: TrailKindSchema,
    orderMode: TrailOrderModeSchema,
    hintsOn: z.boolean(),
    cooldownOn: z.boolean(),
    /** "each player gets K of the stops before the finale" (0 = off). Linear trails, before anyone starts. */
    subsetK: z.number().int().min(0).max(50),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
export type TrailUpdateRequest = z.input<typeof TrailUpdateRequestSchema>;
/** GET /api/hunt/admin/trails */
export const TrailAdminListSchema = z.object({
  trails: z.array(TrailSettingsSchema.extend({ stops: z.number().int(), players: z.number().int(), finished: z.number().int() })),
});
export type TrailAdminList = z.infer<typeof TrailAdminListSchema>;

/** GET /api/hunt/admin/cards?trail=: printable Morse cards to stick on objects (console only: contains the words). */
export const MorseCardSheetSchema = z.object({
  trailId: z.number().int(),
  title: z.string(),
  cards: z.array(
    z.object({
      stopId: z.number().int(),
      position: z.number().int(),
      title: z.string(),
      location: z.string(),
      word: z.string(),
      /** One pattern per letter, e.g. ["-.-.", "---", "-.."] for COD. */
      patterns: z.array(z.string()),
      requireScan: z.boolean(),
      code: z.string(),
      url: z.string(),
    }),
  ),
});
export type MorseCardSheet = z.infer<typeof MorseCardSheetSchema>;

// ---- Morse slips (docs/SLIPS.md) -----------------------------------------------

/** The edge at the bottom of the camera view when the reading is made; 'extra' is a planted decoy sequence. */
export const SLIP_ORIENTATIONS = ['bottom', 'right', 'top', 'left', 'extra'] as const;
export const SlipOrientationSchema = z.enum(SLIP_ORIENTATIONS);
export type SlipOrientation = z.infer<typeof SlipOrientationSchema>;
export const SLIP_OUTCOMES = ['next', 'branch', 'clue', 'bonus', 'decoy'] as const;
export const SlipOutcomeSchema = z.enum(SLIP_OUTCOMES);
export type SlipOutcome = z.infer<typeof SlipOutcomeSchema>;
/**
 * shared: the same slips in every kit. per_kit: each kit's words are drawn from a pool.
 * unique: N printed copies of every slip, each with its own words on every edge; a copy belongs to whoever
 * scans it first (outcomes stay per orientation, shared by every copy).
 */
export const SlipSetModeSchema = z.enum(['shared', 'per_kit', 'unique']);
export type SlipSetMode = z.infer<typeof SlipSetModeSchema>;
/** Unique sets: copies printed by default, and the most the console allows. */
export const UNIQUE_SLIP_COPIES = 80;
export const UNIQUE_SLIP_MAX_COPIES = 200;

/**
 * The matching key for a Morse sequence: letters separated by one space, words by " / ".
 * Accepts the printable look-alikes people and OCR produce (bullets, long dashes, underscores).
 */
export function slipMorseKey(morse: string): string {
  return morse
    .replace(/[\u00b7\u2022\u2219\u25cf]/g, '.')
    .replace(/[\u2013\u2014\u2212_]/g, '-')
    .replace(/[^.\-/ ]/g, '')
    .split('/')
    .map((w) => w.trim().split(/\s+/).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ');
}

/** The matching key for a typed word: its Morse sequence (so typed and scanned readings match the same way). */
export function slipWordKey(word: string): string {
  return word
    .toUpperCase()
    .split(/\s+/)
    .map((w) => wordToPatterns(morseWordOf(w)).join(' '))
    .filter(Boolean)
    .join(' / ');
}

export const SlipReadingInputSchema = z
  .object({
    orientation: SlipOrientationSchema,
    /**
     * The word printed on that edge (shared sets). Per-kit sets leave it empty: words come from the pool.
     * Unique sets leave it empty: every copy gets its own generated word (a word here prints on every copy).
     */
    word: z.string().trim().max(24).nullable().default(null),
    /**
     * Explicit sequence instead of a word (decoys such as an upside-down strip). On a unique set an
     * 'extra' with no sequence means "this copy's top strip read upside down".
     */
    morse: z.string().trim().max(200).nullable().default(null),
    outcome: SlipOutcomeSchema,
    targetStopId: z.number().int().nullable().default(null),
    targetTrailId: z.number().int().nullable().default(null),
    clue: z.string().trim().max(300).default(''),
    bonusPoints: z.number().int().min(0).max(50).default(0),
    message: z.string().trim().max(200).default(''),
  })
  .refine((r) => r.word === null || isMorseWord(r.word), { message: 'Words can only use letters and digits (Morse has no others).', path: ['word'] });
export type SlipReadingInput = z.input<typeof SlipReadingInputSchema>;

/** POST /api/hunt/admin/slip-sets?trail= */
export const SlipSetInputSchema = z.object({
  title: z.string().trim().min(1).max(60),
  mode: SlipSetModeSchema.default('shared'),
  /** Per-kit sets: the words each kit's readings are drawn from (at least as many as readings). */
  pool: z.array(z.string().trim().min(1).max(24)).max(500).default([]),
  /** Unique sets: how many printed copies of every slip. */
  copies: z.number().int().min(1).max(UNIQUE_SLIP_MAX_COPIES).default(UNIQUE_SLIP_COPIES),
});
export type SlipSetInput = z.input<typeof SlipSetInputSchema>;

/** POST /api/hunt/admin/slip-sets/:id/copies: grow or shrink a unique set to N copies (claimed copies are never dropped). */
export const SlipCopiesRequestSchema = z.object({
  copies: z.number().int().min(1).max(UNIQUE_SLIP_MAX_COPIES),
  /** Throw away every word and draw new ones. Only while nothing is claimed (and before printing!). */
  regenerate: z.boolean().default(false),
});
export type SlipCopiesRequest = z.input<typeof SlipCopiesRequestSchema>;

/** PUT /api/hunt/admin/slip-sets/:id/mode: switch a shared set nobody has used yet to unique copies. */
export const SlipSetModeRequestSchema = z.object({
  mode: z.literal('unique'),
  copies: z.number().int().min(1).max(UNIQUE_SLIP_MAX_COPIES).default(UNIQUE_SLIP_COPIES),
});
export type SlipSetModeRequest = z.input<typeof SlipSetModeRequestSchema>;

/** GET /api/hunt/admin/slip-sets/:id/copies: who holds which printed copy (console only). */
export const SlipCopiesSchema = z.object({
  setId: z.number().int(),
  title: z.string(),
  copies: z.number().int(),
  slips: z.array(z.object({ id: z.number().int(), slipNo: z.number().int(), label: z.string() })),
  rows: z.array(
    z.object({
      serial: z.number().int(),
      cells: z.array(
        z.object({
          slipId: z.number().int(),
          copyId: z.number().int(),
          /** The ticket this copy prints as (balanced over the four designs). */
          design: z.enum(SLIP_TICKETS).nullable().default(null),
          claimedBy: z.object({ attendeeId: z.number().int(), nickname: z.string().nullable() }).nullable(),
          claimedAt: z.number().nullable(),
        }),
      ),
    }),
  ),
  claimed: z.number().int(),
  /** People who have signed in so far: more than `copies` means some will have no slip. */
  signedIn: z.number().int(),
});
export type SlipCopies = z.infer<typeof SlipCopiesSchema>;

/** PUT /api/hunt/admin/slips/:id (and POST /admin/slip-sets/:id/slips): one slip and all its readings. */
export const SlipInputSchema = z.object({
  slipNo: z.number().int().min(1).max(99),
  label: z.string().trim().max(60).default(''),
  readings: z.array(SlipReadingInputSchema).max(8),
});
export type SlipInput = z.input<typeof SlipInputSchema>;

export const SlipReadingAdminSchema = z.object({
  id: z.number().int(),
  orientation: SlipOrientationSchema,
  word: z.string().nullable(),
  morse: z.string().nullable(),
  outcome: SlipOutcomeSchema,
  targetStopId: z.number().int().nullable(),
  targetTrailId: z.number().int().nullable(),
  clue: z.string(),
  bonusPoints: z.number().int(),
  message: z.string(),
  /** People who found this reading so far. */
  finds: z.number().int(),
});
export type SlipReadingAdmin = z.infer<typeof SlipReadingAdminSchema>;
export const SlipSetAdminSchema = z.object({
  id: z.number().int(),
  trailId: z.number().int(),
  title: z.string(),
  mode: SlipSetModeSchema,
  pool: z.array(z.string()),
  /** Unique sets: printed copies per slip, and how many copies (over all slips) are claimed. 0 otherwise. */
  copies: z.number().int().default(0),
  claimed: z.number().int().default(0),
  slips: z.array(z.object({ id: z.number().int(), slipNo: z.number().int(), label: z.string(), readings: z.array(SlipReadingAdminSchema) })),
});
export type SlipSetAdmin = z.infer<typeof SlipSetAdminSchema>;
export const SlipSetListSchema = z.object({ sets: z.array(SlipSetAdminSchema) });
export type SlipSetList = z.infer<typeof SlipSetListSchema>;

/** POST /api/hunt/slip: what the scanner (primary.text, or primary.morse) or a typed word read. */
export const HuntSlipRequestSchema = z
  .object({
    stopId: z.number().int(),
    text: z.string().trim().max(60).optional(),
    morse: z.string().trim().max(300).optional(),
  })
  .refine((b) => Boolean(b.text) || Boolean(b.morse), 'Send the text or the morse you read.');
export type HuntSlipRequest = z.input<typeof HuntSlipRequestSchema>;

/**
 * What a reading did. 'unknown' is the same friendly answer for every wrong sequence: it never hints at the valid ones.
 * 'taken' (unique sets): that printed copy belongs to someone else, or you already claimed another copy of this slip.
 */
export const HuntSlipResultSchema = z.object({
  outcome: z.union([SlipOutcomeSchema, z.literal('unknown'), z.literal('taken')]),
  message: z.string(),
  /** Unique sets: the serial of the copy you hold (after a claim, or when a reading was refused because you hold another). */
  serial: z.number().int().nullable().default(null),
  /** clue outcome: the clue text. */
  clue: z.string().nullable(),
  /** bonus outcome: points paid now (0 when you had already claimed it). */
  points: z.number().int(),
  /** next/branch outcomes: the stop this reading stamped. */
  stamped: HuntSolvedStopSchema.nullable(),
  finish: HuntMyFinishSchema.nullable(),
  /** branch to another trail: that trail is now started for you. */
  unlockedTrailId: z.number().int().nullable(),
  me: HuntMeSchema,
});
export type HuntSlipResult = z.infer<typeof HuntSlipResultSchema>;

/** GET /api/hunt/admin/slip-print?set=: what the slip printer needs (per kit for per-kit sets). */
export const SlipPrintSheetSchema = z.object({
  setId: z.number().int(),
  title: z.string(),
  mode: SlipSetModeSchema,
  /** How this set prints by default (a SLIP_SIZES key, e.g. 'quad': four tickets per A4 page); null = the kit ticket. */
  size: z.string().nullable().default(null),
  slips: z.array(
    z.object({
      slipNo: z.number().int(),
      label: z.string(),
      kitId: z.string().nullable(),
      /** Unique sets: the copy's serial ("no. 037"), printed in the plaque. */
      serial: z.number().int().nullable().default(null),
      /** Unique sets: the copy's own ticket design (all four, balanced); the console can override it. */
      ticket: z.enum(SLIP_TICKETS).nullable().default(null),
      edges: z.object({
        bottom: z.object({ word: z.string(), morse: z.string() }).nullable(),
        right: z.object({ word: z.string(), morse: z.string() }).nullable(),
        top: z.object({ word: z.string(), morse: z.string() }).nullable(),
        left: z.object({ word: z.string(), morse: z.string() }).nullable(),
      }),
    }),
  ),
});
export type SlipPrintSheet = z.infer<typeof SlipPrintSheetSchema>;

/** GET /api/hunt/admin/graph?trail=: nodes and edges, with live counts per edge. */
export const TrailGraphSchema = z.object({
  trailId: z.number().int(),
  nodes: z.array(z.object({ stopId: z.number().int(), title: z.string(), challenge: HuntChallengeSchema, start: z.boolean(), finale: z.boolean(), hereNow: z.number().int(), solvedBy: z.number().int() })),
  edges: z.array(
    z.object({
      from: z.number().int(),
      to: z.number().int().nullable(),
      toTrailId: z.number().int().nullable(),
      kind: z.enum(['exit', 'reading']),
      label: z.string(),
      readingId: z.number().int().nullable(),
      outcome: SlipOutcomeSchema.nullable(),
      count: z.number().int(),
    }),
  ),
  /** Non-finale stops with no way out: organisers should fix these. */
  deadEnds: z.array(z.number().int()),
});
export type TrailGraph = z.infer<typeof TrailGraphSchema>;
