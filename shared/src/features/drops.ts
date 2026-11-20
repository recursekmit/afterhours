// Drops: flash drops, the live feed, the hype meter and streaks. The "the room is alive" layer.
//
// A drop is a short, server-timed surprise every phone and the projector take part in:
//   code    the projector shows a code (or Morse to decode); the first N to type it win big, the rest of the window a little
//   speed   one question; the first right answer wins big, then decreasing points
//   golden  a slip is hidden in the venue; the first to type its word (or scan its QR) takes the bonus and a sticker
//   room    "the room did it": the whole room hits a reaction goal inside the window and everyone gets points
//
// Secrets (codes, answers, golden tokens) live only in the console payloads until a drop closes. The projector
// gets the code drop's challenge (the plain code or its Morse) because showing it IS the drop; phones never do.
import { z } from 'zod';
import { AvatarConfigSchema } from '../avatar';
import { GlyphSchema } from '../palette';

export const DROP_KINDS = ['code', 'speed', 'golden', 'room'] as const;
export const DropKindSchema = z.enum(DROP_KINDS);
export type DropKind = z.infer<typeof DropKindSchema>;

export const DROP_STATUSES = ['draft', 'scheduled', 'live', 'closed', 'cancelled'] as const;
export const DropStatusSchema = z.enum(DROP_STATUSES);
export type DropStatus = z.infer<typeof DropStatusSchema>;

/** Siren + 3-2-1 between "fired" and "claims open". */
export const DROP_LEAD_MS = 3000;
/** Phones and the projector keep showing a closed drop's result this long. */
export const DROP_RESULT_HOLD_MS = 12_000;
/** Phones see "something drops in m:ss" this long before a scheduled drop. */
export const DROP_TEASE_MS = 3 * 60_000;
/** Wrong answers allowed per person per drop. */
export const DROP_ATTEMPTS: Record<DropKind, number> = { code: 6, speed: 3, golden: 8, room: 0 };

/** Codes, golden tokens and typed answers compare like this: upper case, letters and digits only. */
export function normaliseAnswer(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Points for the Nth right answer to a speed question: big for first, then down a ladder to the floor. */
export function speedPoints(rank: number, top: number, floor: number): number {
  return Math.max(floor, Math.round(top * 0.75 ** Math.max(0, rank - 1)));
}

// ---- sizing for the room ------------------------------------------------------
// The library and the hype meter were tuned for a hall of 300. The real room is whoever has signed in
// (60-70 people on the day), so the defaults scale to that, with floors so a small room still has a race.

export const DESIGN_ROOM = 300;

/** First-N winners for a code drop designed with `base` winners for 300: 20 -> 7 at 65 people, never under 3. */
export function scaleWinners(base: number, present: number): number {
  const floor = Math.min(3, base);
  return Math.max(floor, Math.min(base, Math.round((base * 1.5 * Math.max(0, present)) / DESIGN_ROOM)));
}

/** A room goal designed for 300 (reactions + taps in the window): 200 -> 43 at 65 people, never under 30. */
export function scaleGoal(base: number, present: number): number {
  return Math.max(30, Math.round((base * Math.max(0, present)) / DESIGN_ROOM));
}

export const RoomSizingSchema = z.object({
  /** People signed in (event attendance). */
  present: z.number().int(),
  /** Suggested first-N for a code drop. */
  codeWinners: z.number().int(),
  /** Suggested goal for a 60 s everyone-wins drop. */
  roomGoal: z.number().int(),
  /** Activity a minute that fills the hype meter when it is on auto. */
  hypeTarget: z.number().int(),
  /** Reactions in 10 s that make "the room is loud". */
  loudAt: z.number().int(),
});
export type RoomSizing = z.infer<typeof RoomSizingSchema>;

export function roomSizing(present: number): RoomSizing {
  const p = Math.max(0, Math.floor(present));
  return {
    present: p,
    codeWinners: scaleWinners(20, p),
    roomGoal: scaleGoal(200, p),
    hypeTarget: Math.max(30, Math.round(p * 0.5)),
    loudAt: Math.max(15, Math.round((60 * p) / DESIGN_ROOM)),
  };
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'No control characters');

const codeLike = (min: number, max: number) =>
  z
    .string()
    .transform(normaliseAnswer)
    .refine((s) => s.length >= min && s.length <= max, `Use ${min} to ${max} letters or digits.`);

// ---- organiser input ---------------------------------------------------------

export const CodeConfigSchema = z.object({
  kind: z.literal('code'),
  code: codeLike(2, 12),
  /** plain: the projector shows the code. morse: it shows dots and dashes to decode. */
  display: z.enum(['plain', 'morse']).default('plain'),
  /** How many win the big prize. */
  winners: z.number().int().min(1).max(300).default(20),
  winPoints: z.number().int().min(1).max(100).default(15),
  /** Everyone else who gets it in before the window shuts. */
  restPoints: z.number().int().min(0).max(50).default(3),
});

export const SpeedConfigSchema = z
  .object({
    kind: z.literal('speed'),
    question: text(140).min(1),
    /** Empty: a typed answer. 2 to 4: tap one. */
    choices: z.array(text(48).min(1)).max(4).default([]),
    /** Choice questions: the right index. */
    correct: z.number().int().min(0).max(3).nullable().default(null),
    /** Typed questions: every accepted spelling. */
    answers: z.array(text(40).min(1)).max(6).default([]),
    topPoints: z.number().int().min(1).max(100).default(30),
    floorPoints: z.number().int().min(0).max(50).default(5),
  })
  .refine((c) => c.choices.length !== 1, { message: 'Give 2 to 4 choices, or none for a typed answer.', path: ['choices'] })
  .refine((c) => (c.choices.length === 0 ? c.answers.some((a) => normaliseAnswer(a).length > 0) : c.correct !== null && c.correct < c.choices.length), {
    message: 'Say which answer is right.',
    path: ['correct'],
  });

export const GoldenConfigSchema = z.object({
  kind: z.literal('golden'),
  /** The word on the slip (and inside its QR). */
  token: codeLike(3, 24),
  /** Shown on phones and the projector: a nudge, not the answer. */
  hint: text(120).default(''),
  bonus: z.number().int().min(1).max(200).default(50),
});

export const RoomConfigSchema = z.object({
  kind: z.literal('room'),
  /** Reactions (from the reaction bar and the big drop button) needed inside the window. */
  goal: z.number().int().min(10).max(10_000).default(200),
  points: z.number().int().min(1).max(50).default(5),
});

export const DropConfigSchema = z.union([CodeConfigSchema, SpeedConfigSchema, GoldenConfigSchema, RoomConfigSchema]);
export type DropConfig = z.output<typeof DropConfigSchema>;
export type DropConfigInput = z.input<typeof DropConfigSchema>;

const epoch = z.number().int().min(1_500_000_000_000).max(4_000_000_000_000);

export const DropInputSchema = z.object({
  title: text(60).min(1),
  blurb: text(160).default(''),
  durationSec: z.number().int().min(10).max(3600).default(60),
  config: DropConfigSchema,
});
export type DropInput = z.output<typeof DropInputSchema>;

/** POST /api/drops/admin: save a draft, schedule it (fireAt) or fire it now. */
export const CreateDropRequestSchema = DropInputSchema.extend({
  when: z.union([z.literal('now'), z.literal('draft'), z.object({ at: epoch })]).default('draft'),
});
export type CreateDropRequest = z.input<typeof CreateDropRequestSchema>;

/** POST /api/drops/admin/:id/schedule */
export const ScheduleDropRequestSchema = z.object({ at: epoch });

/** POST /api/drops/:id/claim */
export const ClaimRequestSchema = z.object({ answer: z.string().max(60) });
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

/** POST /api/drops/:id/tap: taps on the room drop's big button. Batched client side. */
export const TapRequestSchema = z.object({ n: z.number().int().min(1).max(10).default(1) });

// ---- what phones and the projector see -----------------------------------------

export const PublicDropSchema = z.object({
  id: z.number().int(),
  kind: DropKindSchema,
  title: z.string(),
  blurb: z.string(),
  status: DropStatusSchema,
  /** Fired (siren) at; claims open at opensAt = firedAt + DROP_LEAD_MS. */
  firedAt: z.number().int().nullable(),
  opensAt: z.number().int().nullable(),
  closesAt: z.number().int().nullable(),
  closedAt: z.number().int().nullable(),
  /** code: winners. speed: 1. golden: 1. room: null. */
  slots: z.number().int().nullable(),
  /** speed */
  question: z.string().nullable(),
  choices: z.array(z.string()).nullable(),
  /** golden */
  hint: z.string().nullable(),
  /** room */
  goal: z.number().int().nullable(),
  /** code: 'plain' | 'morse' (so a phone can say "decode the dots on the big screen"). */
  display: z.enum(['plain', 'morse']).nullable(),
  /** Headline prize and the consolation (code rest points, speed floor, room per person). */
  topPoints: z.number().int(),
  restPoints: z.number().int(),
  /** Only once closed: the code, the right answer or the golden word. */
  reveal: z.string().nullable(),
  /** room, once closed: did the room hit the goal? */
  achieved: z.boolean().nullable(),
});
export type PublicDrop = z.infer<typeof PublicDropSchema>;

/** The projector also gets the code drop's challenge. */
export const ChallengeSchema = z.discriminatedUnion('display', [
  z.object({ display: z.literal('plain'), text: z.string() }),
  z.object({ display: z.literal('morse'), patterns: z.array(z.string()) }),
]);
export type Challenge = z.infer<typeof ChallengeSchema>;

export const DropWinnerSchema = z.object({
  rank: z.number().int(),
  nickname: z.string(),
  avatar: AvatarConfigSchema,
  points: z.number().int(),
  at: z.number().int(),
});
export type DropWinner = z.infer<typeof DropWinnerSchema>;

/** Live numbers for the drop on every screen. Also the 'drops.tally' payload (coalesced, ~2.5 per second max). */
export const DropTallySchema = z.object({
  dropId: z.number().int(),
  /** Right answers so far. */
  claimed: z.number().int(),
  slots: z.number().int().nullable(),
  /** room: reactions + taps inside the window. */
  count: z.number().int(),
  goal: z.number().int().nullable(),
  /** People who tried at all. */
  players: z.number().int(),
  /** Top places in order (up to 10), newest last. */
  winners: z.array(DropWinnerSchema),
});
export type DropTally = z.infer<typeof DropTallySchema>;

export const CLAIM_OUTCOMES = ['won', 'bonus', 'wrong', 'out', 'too_slow', 'already'] as const;
export const ClaimOutcomeSchema = z.enum(CLAIM_OUTCOMES);
export type ClaimOutcome = z.infer<typeof ClaimOutcomeSchema>;

/**
 * Your claim on a drop.
 * - won: a top place (code: one of the first N; speed: podium; golden: first finder)
 * - bonus: right, but after the top places; smaller points
 * - wrong: not it, try again (attemptsLeft)
 * - out: out of tries for this drop
 * - too_slow: golden already found, or the window had shut
 * - already: you already got this one
 */
export const MyClaimSchema = z.object({
  outcome: ClaimOutcomeSchema,
  rank: z.number().int().nullable(),
  points: z.number().int(),
  attemptsLeft: z.number().int(),
});
export type MyClaim = z.infer<typeof MyClaimSchema>;

export const ClaimResponseSchema = MyClaimSchema.extend({ message: z.string() });
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

/** GET /api/drops/current (attendee) */
export const CurrentDropResponseSchema = z.object({
  /** Live, in its 3-2-1 lead, or closed in the last DROP_RESULT_HOLD_MS. */
  drop: PublicDropSchema.nullable(),
  tally: DropTallySchema.nullable(),
  mine: MyClaimSchema.nullable(),
  /** A scheduled drop lands at this time (only inside DROP_TEASE_MS). What it is stays a surprise. */
  nextAt: z.number().int().nullable(),
  serverNow: z.number().int(),
});
export type CurrentDropResponse = z.infer<typeof CurrentDropResponseSchema>;

/** GET /api/drops/screen */
export const ScreenDropResponseSchema = z.object({
  drop: PublicDropSchema.nullable(),
  challenge: ChallengeSchema.nullable(),
  tally: DropTallySchema.nullable(),
  nextAt: z.number().int().nullable(),
  serverNow: z.number().int(),
});
export type ScreenDropResponse = z.infer<typeof ScreenDropResponseSchema>;

// ---- streaks ------------------------------------------------------------------

export const STREAK_STICKER_AT = 3;

/** GET /api/drops/me: "3 in a row" = you did something in each of the last 3 activities. */
export const MyStreakSchema = z.object({
  streak: z.number().int(),
  best: z.number().int(),
  /** The recent activities, oldest first, and whether you did something in each. */
  recent: z.array(z.object({ title: z.string(), did: z.boolean(), live: z.boolean() })),
});
export type MyStreak = z.infer<typeof MyStreakSchema>;

// ---- feed ----------------------------------------------------------------------

export const FEED_TONES = ['drop', 'win', 'info', 'hype', 'note'] as const;
export const FeedToneSchema = z.enum(FEED_TONES);
export type FeedTone = z.infer<typeof FeedToneSchema>;

export const FeedItemSchema = z.object({
  id: z.string(),
  at: z.number().int(),
  text: z.string(),
  tone: FeedToneSchema,
  icon: GlyphSchema,
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

/** GET /api/drops/feed */
export const FeedStateSchema = z.object({ items: z.array(FeedItemSchema), muted: z.boolean() });
export type FeedState = z.infer<typeof FeedStateSchema>;

/** 'drops.feed': new lines (coalesced, at most one event per ~2.5 s), lines an organiser hid, and the mute switch. */
export const FeedEventSchema = z.object({ items: z.array(FeedItemSchema), hidden: z.array(z.string()), muted: z.boolean() });
export type FeedEvent = z.infer<typeof FeedEventSchema>;

/** POST /api/drops/admin/feed: an organiser line. */
export const FeedSayRequestSchema = z.object({ text: text(90).min(1) });

// ---- hype ------------------------------------------------------------------------

export const HypeStateSchema = z.object({
  enabled: z.boolean(),
  /** 0..1 of the target. */
  level: z.number(),
  /** Things that happened in the last minute (points earned, reactions, drop taps and claims). */
  perMin: z.number().int(),
  target: z.number().int(),
  /** Last "the room is on fire" moment. */
  onFireAt: z.number().int().nullable(),
});
export type HypeState = z.infer<typeof HypeStateSchema>;

export const OnFireEventSchema = z.object({ at: z.number().int(), dropId: z.number().int().nullable() });
export type OnFireEvent = z.infer<typeof OnFireEventSchema>;

// ---- console ---------------------------------------------------------------------

export const DropSettingsSchema = z.object({
  feedMuted: z.boolean(),
  hypeEnabled: z.boolean(),
  /** When the meter maxes out, fire an "everyone wins" drop by itself. */
  hypeAuto: z.boolean(),
  /** Activity per minute that fills the meter (used when hypeTargetAuto is off). */
  hypeTarget: z.number().int().min(20).max(5000),
  /** Size the meter to the people signed in (roomSizing). Setting hypeTarget turns this off. */
  hypeTargetAuto: z.boolean(),
});
export type DropSettings = z.infer<typeof DropSettingsSchema>;
export const DropSettingsPatchSchema = DropSettingsSchema.partial().strict();

export const AdminDropSchema = PublicDropSchema.extend({
  config: DropConfigSchema,
  durationSec: z.number().int(),
  fireAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  claimed: z.number().int(),
  players: z.number().int(),
  count: z.number().int(),
  library: z.string().nullable(),
});
export type AdminDrop = z.infer<typeof AdminDropSchema>;

export const LibraryDropSchema = z.object({
  id: z.string(),
  /** Short tag on the card. */
  tag: z.string(),
  input: DropInputSchema,
});
export type LibraryDrop = z.infer<typeof LibraryDropSchema>;

export const AdminFeedItemSchema = FeedItemSchema.extend({ hidden: z.boolean() });

/** GET /api/drops/admin */
export const DropsAdminStateSchema = z.object({
  drops: z.array(AdminDropSchema),
  library: z.array(LibraryDropSchema),
  settings: DropSettingsSchema,
  feed: z.array(AdminFeedItemSchema),
  hype: HypeStateSchema,
  tally: DropTallySchema.nullable(),
  /** Defaults sized to who is signed in; the library above is already scaled with them. */
  room: RoomSizingSchema,
  serverNow: z.number().int(),
});
export type DropsAdminState = z.infer<typeof DropsAdminStateSchema>;

export const AdminClaimSchema = z.object({
  nickname: z.string(),
  kitId: z.string(),
  correct: z.boolean(),
  rank: z.number().int().nullable(),
  points: z.number().int(),
  attempts: z.number().int(),
  at: z.number().int(),
});
export const AdminClaimsResponseSchema = z.object({ claims: z.array(AdminClaimSchema) });
export type AdminClaimsResponse = z.infer<typeof AdminClaimsResponseSchema>;

/** POST /api/drops/admin/reset (danger zone) */
export const ResetDropsRequestSchema = z.object({ confirm: z.literal('reset drops') });

// ---- live events -------------------------------------------------------------------

export const DropLiveEventSchema = z.object({ drop: PublicDropSchema });
export const DropClosedEventSchema = z.object({ drop: PublicDropSchema, tally: DropTallySchema });
export type DropClosedEvent = z.infer<typeof DropClosedEventSchema>;

declare module '../live' {
  interface LiveEvents {
    /** To everyone: a drop just fired (siren now, claims open at opensAt). Phones take over, the projector switches. */
    'drops.live': { drop: PublicDrop };
    /** To screens: the live drop's challenge (code drops), sent right after 'drops.live'. */
    'drops.challenge': { dropId: number; challenge: Challenge | null };
    /** To everyone: claim counter, room progress and winners for the live drop. Coalesced. */
    'drops.tally': DropTally;
    /** To everyone: the drop closed (or was cancelled), with the reveal and the final tally. */
    'drops.closed': DropClosedEvent;
    /** To everyone: drops were scheduled, changed or reset; refetch. */
    'drops.changed': { at: number };
    /** To everyone: new feed lines, hidden lines, the mute switch. */
    'drops.feed': FeedEvent;
    /** To screens: the hype meter moved. Throttled. */
    'drops.hype': HypeState;
    /** To everyone: the hype meter maxed out. */
    'drops.on-fire': OnFireEvent;
  }
}
