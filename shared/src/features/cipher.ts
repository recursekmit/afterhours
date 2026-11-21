// The Cipher Ticket: the main Morse activity (six trials on your own printed ticket).
//
// Every player holds ONE serial of the standalone Morse ticket set (docs/SLIPS.md, unique copies): four
// slips, I to IV, printed on one A4 page in the four designs. The first scan of any of them reserves the
// whole serial. Slip I's print design is the player's guild: armillary (maroon), wave (navy), ginkgo
// (forest), ruins (plum).
//
//   1 the oath          scan any slip: the serial becomes yours, you swear into slip I's guild
//   2 the four winds    read all four edges of slip I (its top read upside down is "cursed": still counts)
//   3 the echo          decode the edge of slip II the app names, then tap it on the brass key
//   4 the whisper       the phone plays a word printed on no slip; decode it
//   5 the riddle        decode the four edges of slip III; type the one the riddle asks for
//   6 the pact          scan a partner's slip IV (another guild), or the Oracle's ticket
//   7 the last signal   the projector sends one word to the whole hall; type it
//
// Secrets that never travel to a phone before they are solved: the whisper word (only its on/off timing),
// the echo and riddle words (they are on the player's slips, to be decoded), the partner's edge word, the
// Oracle's words, the last signal's word (the projector gets its timing; the word after the reveal).
import { z } from 'zod';
import { AvatarConfigSchema } from '../avatar';
import { type SlipEdge, type SlipTicket, SLIP_TICKETS } from '../morse-slip';
import { MORSE_TABLE, type MorseSignal, unitMsForWpm, wordToPatterns } from './morse';

// ---------------------------------------------------------------------------
// guilds
// ---------------------------------------------------------------------------

export const GUILDS = SLIP_TICKETS;
export type Guild = SlipTicket;
export const GuildSchema = z.enum(SLIP_TICKETS);

export interface GuildInfo {
  id: Guild;
  /** "the Guild of the Wave" */
  title: string;
  /** short: "the wave" */
  short: string;
  /** the ticket's ground, in words */
  colour: string;
  /** kit tone for cards and bars */
  tone: 'tangerine' | 'sky' | 'lime' | 'grape';
  /** one line of oath */
  oath: string;
}

export const GUILD_INFO: Record<Guild, GuildInfo> = {
  armillary: { id: 'armillary', title: 'the Guild of the Armillary', short: 'the armillary', colour: 'maroon', tone: 'tangerine', oath: 'by ring and sphere, i keep the turning of the stars.' },
  wave: { id: 'wave', title: 'the Guild of the Wave', short: 'the wave', colour: 'navy', tone: 'sky', oath: 'by tide and moon, i carry every signal home.' },
  ginkgo: { id: 'ginkgo', title: 'the Guild of the Ginkgo', short: 'the ginkgo', colour: 'green', tone: 'lime', oath: 'by leaf and lantern, i read what others miss.' },
  ruins: { id: 'ruins', title: 'the Guild of the Ruins', short: 'the ruins', colour: 'plum', tone: 'grape', oath: 'by stone and wisteria, i keep the old words alive.' },
};

/**
 * The print design of slip `slipNo` (1..4) of serial `serial`, when the copy data does not store it: each
 * A4 page holds all four designs, rotated by serial, so slip I (the guild) cycles armillary, wave, ginkgo,
 * ruins over serials 1, 2, 3, 4, 5... The server prefers a design stored on the copy.
 */
export function designFor(serial: number, slipNo = 1): Guild {
  return GUILDS[(Math.max(1, Math.floor(serial)) - 1 + Math.max(1, Math.floor(slipNo)) - 1) % GUILDS.length] as Guild;
}
/** The guild of a serial when no design is stored: slip I's derived design. */
export const guildForSerial = (serial: number): Guild => designFor(serial, 1);

export const SLIP_NAMES = ['I', 'II', 'III', 'IV'] as const;
/** Which slip each trial reads. */
export const SLIP_OF = { winds: 1, echo: 2, riddle: 3, pact: 4 } as const;

// ---------------------------------------------------------------------------
// trials
// ---------------------------------------------------------------------------

export const TRIALS = ['oath', 'winds', 'echo', 'whisper', 'riddle', 'pact', 'signal'] as const;
export type TrialId = (typeof TRIALS)[number];
export const TrialIdSchema = z.enum(TRIALS);
/** 1-based trial number of an id. */
export const trialNo = (t: TrialId): number => TRIALS.indexOf(t) + 1;

export const TRIAL_INFO: Record<TrialId, { title: string; rule: string }> = {
  oath: { title: 'the oath', rule: 'scan any of your four slips. all four become yours, and slip I names your guild.' },
  winds: { title: 'the four winds', rule: 'read all four edges of slip I, in any order. turn it all the way round.' },
  echo: { title: 'the echo', rule: 'decode the edge of slip II we name, then tap that word on the brass key.' },
  whisper: { title: 'the whisper', rule: 'your phone whispers a word printed on no slip. decode it.' },
  riddle: { title: 'the riddle', rule: 'decode all four edges of slip III, then answer the riddle with one of them.' },
  pact: { title: 'the pact', rule: 'find your partner from another guild. scan each other’s slip IV at the edge we name.' },
  signal: { title: 'the last signal', rule: 'watch the projector. one word, three times. type it before the hall does.' },
};

export const EDGE_RUNE: Record<SlipEdge, { wind: string; compass: string }> = {
  bottom: { wind: 'the south wind', compass: 'S' },
  right: { wind: 'the east wind', compass: 'E' },
  top: { wind: 'the north wind', compass: 'N' },
  left: { wind: 'the west wind', compass: 'W' },
};

export const EdgeSchema = z.enum(['bottom', 'right', 'top', 'left']);

// ---------------------------------------------------------------------------
// settings (console, all editable)
// ---------------------------------------------------------------------------

export const CipherPointsSchema = z.object({
  oath: z.number().int().min(0).max(200),
  rune: z.number().int().min(0).max(200),
  echoStar: z.number().int().min(0).max(200),
  whisper: z.number().int().min(0).max(200),
  riddle: z.number().int().min(0).max(200),
  pact: z.number().int().min(0).max(200),
  signalFirst: z.number().int().min(0).max(500),
  signalCorrect: z.number().int().min(0).max(200),
  champion: z.number().int().min(0).max(200),
  /** paid on top of a trial sealed inside its par time */
  speed: z.number().int().min(0).max(100),
});
export type CipherPoints = z.infer<typeof CipherPointsSchema>;

export const CipherSettingsSchema = z.object({
  /** the four winds: hint 1 ("turn it all the way round") and hint 2 (name the missing edges), seconds */
  windsHint1Sec: z.number().int().min(10).max(3600),
  windsHint2Sec: z.number().int().min(10).max(3600),
  /** the echo: tolerance on dit/dah and gap boundaries (1 = strict judgeTaps, 1.5 = forgiving) */
  echoTolerance: z.number().min(1).max(3),
  echoTries: z.number().int().min(1).max(10),
  /** rhythm (0..1) for 2 and 3 stars */
  echoStar2: z.number().min(0).max(1),
  echoStar3: z.number().min(0).max(1),
  /** the whisper: character speed and Farnsworth (effective) speed, letters */
  whisperWpm: z.number().min(3).max(25),
  whisperFarnsworthWpm: z.number().min(2).max(25),
  whisperMinLetters: z.number().int().min(2).max(6),
  whisperMaxLetters: z.number().int().min(2).max(6),
  /** points off for hint 1 (first letter) and hint 2 (letter count) */
  whisperHintCost: z.number().int().min(0).max(50),
  /** points off for the riddle's hint (which edge holds the answer) */
  riddleHintCost: z.number().int().min(0).max(50),
  /** the pact: open to players, seconds to wait before re-pair / the Oracle */
  pactOpen: z.boolean(),
  pactWaitSec: z.number().int().min(15).max(3600),
  /** the last signal */
  signalWpm: z.number().min(3).max(20),
  signalLoops: z.number().int().min(1).max(6),
  signalFirstN: z.number().int().min(1).max(100),
  /** answers accepted this long after the signal goes live */
  signalWindowSec: z.number().int().min(30).max(3600),
  signalWarnSec: z.number().int().min(0).max(1800),
  /** par time per trial for the speed bonus, seconds */
  parSec: z.number().int().min(10).max(3600),
  points: CipherPointsSchema,
  /** the Oracle's printed ticket: fixed words per edge (kept server-side, console only) */
  oracle: z.object({ bottom: z.string().min(1).max(6), right: z.string().min(1).max(6), top: z.string().min(1).max(6), left: z.string().min(1).max(6) }),
});
export type CipherSettings = z.infer<typeof CipherSettingsSchema>;

export const DEFAULT_CIPHER_SETTINGS: CipherSettings = {
  windsHint1Sec: 120,
  windsHint2Sec: 240,
  echoTolerance: 1.5,
  echoTries: 3,
  echoStar2: 0.45,
  echoStar3: 0.7,
  whisperWpm: 8,
  whisperFarnsworthWpm: 5,
  whisperMinLetters: 3,
  whisperMaxLetters: 4,
  whisperHintCost: 4,
  riddleHintCost: 4,
  pactOpen: true,
  pactWaitSec: 180,
  signalWpm: 6,
  signalLoops: 3,
  signalFirstN: 10,
  signalWindowSec: 300,
  signalWarnSec: 300,
  parSec: 150,
  // The whole quest is worth about the treasure hunt (eight stops at 10, a finale, rank and speed bonuses:
  // roughly 100 to 170). Here: oath 5, runes 20, echo up to 24, whisper 20, riddle 15, pact 20, the last
  // signal 15 or 40, the winning guild 10, plus up to 25 in speed bonuses: about 130 to 180.
  points: { oath: 5, rune: 5, echoStar: 8, whisper: 20, riddle: 15, pact: 20, signalFirst: 40, signalCorrect: 15, champion: 10, speed: 5 },
  oracle: { bottom: 'SAGE', right: 'SUN', top: 'OMEN', left: 'EYE' },
};

// ---------------------------------------------------------------------------
// the echo: judgeTaps with a looser dit/dah and gap boundary
// ---------------------------------------------------------------------------

/**
 * Stars for an echo: 0 = not passed, 1 = passed, 2/3 = good rhythm.
 * `strictOk`: judgeTaps said ok; `lenientOk`: the press kinds and gaps fit the word within the tolerance.
 */
export function echoStars(passed: boolean, rhythm: number, s: Pick<CipherSettings, 'echoStar2' | 'echoStar3'>): number {
  if (!passed) return 0;
  if (rhythm >= s.echoStar3) return 3;
  if (rhythm >= s.echoStar2) return 2;
  return 1;
}

/**
 * The forgiving check behind the echo: with the attendee's own unit u, every press the word wants as a
 * dit must be under 2u x tol, every dah over 2u / tol; every gap inside a letter under 2u x tol and every
 * gap between letters over 2u / tol. tol = 1 is judgeTaps' own boundary; 1.5 is "medium, never punishing".
 */
export function fitsWithTolerance(word: string, presses: readonly (readonly [number, number])[], unitMs: number, tol: number): boolean {
  let patterns: string[];
  try {
    patterns = wordToPatterns(word);
  } catch {
    return false;
  }
  const kinds = patterns.join('');
  if (presses.length !== kinds.length || unitMs <= 0) return false;
  const wantGaps: number[] = [];
  patterns.forEach((p, li) => {
    for (let i = 0; i < p.length - 1; i++) wantGaps.push(1);
    if (li < patterns.length - 1) wantGaps.push(3);
  });
  const edge = 2 * unitMs;
  for (let i = 0; i < presses.length; i++) {
    const [d, u] = presses[i] as readonly [number, number];
    const dur = u - d;
    if (kinds[i] === '.' ? dur >= edge * tol : dur <= edge / tol) return false;
    if (i > 0) {
      const gap = d - (presses[i - 1] as readonly [number, number])[1];
      if (gap < 0) return false;
      const want = wantGaps[i - 1];
      if (want === 1 ? gap >= edge * tol : gap <= edge / tol) return false;
      // a word gap (7u) would split the word
      if (gap >= 5 * unitMs * tol) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// the whisper and the last signal: Farnsworth timing (letters at wpm, gaps stretched to fwpm)
// ---------------------------------------------------------------------------

/** On/off timing for a word: letters at `wpm`, letter gaps stretched to an effective `fwpm` (Farnsworth). */
export function farnsworthSignal(word: string, wpm: number, fwpm: number, leadInMs = 700): MorseSignal {
  const u = unitMsForWpm(wpm);
  const eff = Math.min(fwpm, wpm);
  // ARRL: total extra delay per standard word, spread over the 19 gap units of PARIS
  const ta = ((60 * wpm - 37.2 * eff) / (wpm * eff)) * 1000;
  const letterGap = Math.max(3 * u, (3 * ta) / 19);
  const segments: number[] = [];
  wordToPatterns(word).forEach((pattern, li) => {
    if (li > 0) segments.push(Math.round(letterGap));
    [...pattern].forEach((el, ei) => {
      if (ei > 0) segments.push(Math.round(u));
      segments.push(Math.round(el === '.' ? u : 3 * u));
    });
  });
  return { unitMs: Math.round(u), segments, totalMs: segments.reduce((a, b) => a + b, 0), leadInMs };
}

/** Repeat a signal `loops` times with a long rest between (the projector's last signal). */
export function loopSignal(sig: MorseSignal, loops: number, restMs: number): MorseSignal {
  const segments: number[] = [];
  for (let i = 0; i < loops; i++) {
    if (i > 0) segments.push(restMs);
    segments.push(...sig.segments);
  }
  return { ...sig, segments, totalMs: segments.reduce((a, b) => a + b, 0) };
}

export const isMorseWord = (w: string): boolean => w.length > 0 && [...w.toUpperCase()].every((c) => MORSE_TABLE[c] !== undefined);

// ---------------------------------------------------------------------------
// wire shapes
// ---------------------------------------------------------------------------

const SignalSchema = z.object({ unitMs: z.number(), segments: z.array(z.number()), totalMs: z.number(), leadInMs: z.number() });

/** A reading from the scanner or the keypad: primary.text, else primary.morse (docs/SLIPS.md). */
export const CipherReadSchema = z.object({ text: z.string().max(40).optional(), morse: z.string().max(200).optional() }).refine((r) => Boolean(r.text?.trim() || r.morse?.trim()), 'Scan or type a reading.');
export type CipherRead = z.infer<typeof CipherReadSchema>;

export const StarSchema = z.object({
  trial: TrialIdSchema,
  sealedAt: z.number().nullable(),
  /** 0..3, the echo's rhythm stars; other trials 3 when sealed fast, else 2; 0 while open */
  stars: z.number().int().min(0).max(3),
  points: z.number().int(),
});
export type Star = z.infer<typeof StarSchema>;

export const PartnerSchema = z.object({ nickname: z.string(), avatar: AvatarConfigSchema, guild: GuildSchema });
export type Partner = z.infer<typeof PartnerSchema>;

export const PactViewSchema = z.object({
  /** locked: the pact is not open yet; waiting: in the pool; paired / oracle: scan each other; sealed */
  status: z.enum(['locked', 'waiting', 'paired', 'oracle', 'sealed']),
  partner: PartnerSchema.nullable(),
  /** the edge of the PARTNER's slip IV (or the Oracle's ticket) you scan */
  scanEdge: EdgeSchema.nullable(),
  /** the edge of YOUR slip IV they scan */
  showEdge: EdgeSchema.nullable(),
  iScanned: z.boolean(),
  theyScanned: z.boolean(),
  since: z.number().nullable(),
  /** after the wait: re-pair or the Oracle are offered */
  canRepair: z.boolean(),
  waiting: z.number().int(),
});
export type PactView = z.infer<typeof PactViewSchema>;

export const SignalStatusSchema = z.enum(['idle', 'warned', 'live', 'closed']);
export const SignalViewSchema = z.object({
  id: z.number().nullable(),
  status: SignalStatusSchema,
  warnAt: z.number().nullable(),
  fireAt: z.number().nullable(),
  closesAt: z.number().nullable(),
  letters: z.number().int().nullable(),
  /** can this player answer (trials 1-6 sealed) */
  eligible: z.boolean(),
  answered: z.object({ rank: z.number().int(), points: z.number().int() }).nullable(),
  firstN: z.number().int(),
  correct: z.number().int(),
  /** after the reveal only */
  word: z.string().nullable(),
  winner: GuildSchema.nullable(),
});
export type SignalView = z.infer<typeof SignalViewSchema>;

export const CipherMeSchema = z.object({
  /** the "show morse challenge to players" switch */
  visible: z.boolean(),
  /** a Morse ticket set exists */
  ready: z.boolean(),
  ticket: z.object({ serial: z.number().int(), guild: GuildSchema, claimedAt: z.number() }).nullable(),
  /** the trial you are on, 1..7; 8 = all sealed */
  trial: z.number().int().min(1).max(8),
  /** the pact or the last signal is not open yet: "next trials open soon" */
  nextSoon: z.boolean(),
  stars: z.array(StarSchema),
  points: z.number().int(),
  streak: z.number().int(),
  /** when the current trial began (its timer) */
  trialStartedAt: z.number().nullable(),
  parSec: z.number().int(),
  /** people on each trial right now (index 0 = trial 1) */
  crowd: z.array(z.number().int()),
  winds: z.object({
    found: z.object({ bottom: z.boolean(), right: z.boolean(), top: z.boolean(), left: z.boolean() }),
    cursed: z.boolean(),
    /** 0 none, 1 "turn it all the way round", 2 the missing edges named */
    hint: z.number().int().min(0).max(2),
    hint1At: z.number().nullable(),
    hint2At: z.number().nullable(),
  }),
  /** the echo: which edge of slip II to decode and tap (the word itself only once sealed) */
  echo: z.object({ edge: EdgeSchema.nullable(), letters: z.number().int().nullable(), word: z.string().nullable(), tries: z.number().int(), triesLeft: z.number().int(), stars: z.number().int() }),
  /** the riddle on slip III: 'first' / 'last' = the edge word that comes first / last alphabetically */
  riddle: z.object({ rule: z.enum(['first', 'last']).nullable(), hintEdge: EdgeSchema.nullable(), hintUsed: z.boolean(), tries: z.number().int(), hintCost: z.number().int() }),
  whisper: z.object({
    signal: SignalSchema.nullable(),
    hintsUsed: z.number().int(),
    firstLetter: z.string().nullable(),
    letters: z.number().int().nullable(),
    tries: z.number().int(),
    hintCost: z.number().int(),
  }),
  pact: PactViewSchema,
  signal: SignalViewSchema,
});
export type CipherMe = z.infer<typeof CipherMeSchema>;

export const ScanOutcomeSchema = z.enum(['claimed', 'rune', 'cursed', 'again', 'unknown', 'taken', 'not_yours', 'sealed', 'pact_half', 'pact_sealed']);
export const ScanResultSchema = z.object({
  outcome: ScanOutcomeSchema,
  edge: EdgeSchema.nullable(),
  message: z.string(),
  points: z.number().int(),
  me: CipherMeSchema,
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const EchoRequestSchema = z.object({ presses: z.array(z.tuple([z.number().int().min(0).max(300_000), z.number().int().min(0).max(300_000)])).min(1).max(80) });
export const EchoResultSchema = z.object({
  passed: z.boolean(),
  stars: z.number().int(),
  verdict: z.string(),
  decoded: z.string(),
  rhythm: z.number(),
  letterOk: z.array(z.boolean()),
  presses: z.array(z.object({ got: z.enum(['dit', 'dah']), ratio: z.number() })),
  triesLeft: z.number().int(),
  sealed: z.boolean(),
  points: z.number().int(),
  message: z.string(),
  me: CipherMeSchema,
});
export type EchoResult = z.infer<typeof EchoResultSchema>;

export const GuessSchema = z.object({ guess: z.string().min(1).max(24) });
export const GuessResultSchema = z.object({
  correct: z.boolean(),
  /** 'close' = one letter off */
  close: z.boolean(),
  points: z.number().int(),
  message: z.string(),
  me: CipherMeSchema,
});
export type GuessResult = z.infer<typeof GuessResultSchema>;

// ---- projector --------------------------------------------------------------

export const GuildStandingSchema = z.object({
  guild: GuildSchema,
  members: z.number().int(),
  points: z.number().int(),
  /** points per member, one decimal */
  average: z.number(),
  rank: z.number().int(),
});
export type GuildStanding = z.infer<typeof GuildStandingSchema>;

export const CipherScreenSchema = z.object({
  visible: z.boolean(),
  players: z.number().int(),
  guilds: z.array(GuildStandingSchema),
  /** people on each trial right now, and sealed totals per trial */
  onTrial: z.array(z.number().int()),
  sealed: z.array(z.number().int()),
  pactsSealed: z.number().int(),
  recentPacts: z.array(z.object({ a: z.string(), b: z.string(), ga: GuildSchema, gb: GuildSchema.nullable(), at: z.number() })),
  signal: SignalViewSchema,
  /** the projector's playback (timing only; never the word until it is revealed) */
  signalPlay: SignalSchema.nullable(),
  firstAnswers: z.array(z.object({ nickname: z.string(), avatar: AvatarConfigSchema, guild: GuildSchema, rank: z.number().int() })),
});
export type CipherScreen = z.infer<typeof CipherScreenSchema>;

// ---- console ----------------------------------------------------------------

export const CipherAdminPlayerSchema = z.object({
  attendeeId: z.number().int(),
  nickname: z.string(),
  serial: z.number().int(),
  guild: GuildSchema,
  trial: z.number().int(),
  trialStartedAt: z.number().nullable(),
  claimedAt: z.number(),
  stars: z.number().int(),
  points: z.number().int(),
  pact: z.string().nullable(),
});
export type CipherAdminPlayer = z.infer<typeof CipherAdminPlayerSchema>;

export const CipherAdminPactSchema = z.object({
  id: z.number().int(),
  a: z.string(),
  b: z.string().nullable(),
  oracle: z.boolean(),
  status: z.enum(['open', 'sealed', 'broken']),
  aScanned: z.boolean(),
  bScanned: z.boolean(),
  createdAt: z.number(),
});

export const CipherAdminSchema = z.object({
  visible: z.boolean(),
  set: z.object({ id: z.number().int(), trailId: z.number().int(), copies: z.number().int(), claimed: z.number().int() }).nullable(),
  settings: CipherSettingsSchema,
  players: z.array(CipherAdminPlayerSchema),
  onTrial: z.array(z.number().int()),
  sealed: z.array(z.number().int()),
  guilds: z.array(GuildStandingSchema),
  pacts: z.array(CipherAdminPactSchema),
  waiting: z.array(z.object({ attendeeId: z.number().int(), nickname: z.string(), guild: GuildSchema, since: z.number() })),
  signal: SignalViewSchema,
  /** the console sees the word it is about to send */
  signalWord: z.string().nullable(),
});
export type CipherAdmin = z.infer<typeof CipherAdminSchema>;

/** The Oracle's printed ticket (console only). Player slips print from the trails console (hunt). */
export const CipherPrintSchema = z.object({
  oracle: z.object({ bottom: z.string(), right: z.string(), top: z.string(), left: z.string() }),
});
export type CipherPrint = z.infer<typeof CipherPrintSchema>;

export const SignalFireSchema = z.object({
  action: z.enum(['warn', 'fire', 'close', 'reveal', 'cancel']),
  /** warn: minutes until it fires (projector countdown) */
  inSec: z.number().int().min(0).max(3600).optional(),
  /** optional: a word of your own (4-5 letters); otherwise one is drawn */
  word: z.string().max(8).optional(),
});
export type SignalFire = z.infer<typeof SignalFireSchema>;

export const CIPHER_RESET_PHRASE = 'RESET CIPHER';
export const CipherResetSchema = z.object({ confirm: z.literal(CIPHER_RESET_PHRASE) });

// ---- live -------------------------------------------------------------------

declare module '../live' {
  interface LiveEvents {
    /** To one attendee: your cipher state moved (a partner scanned you, the console re-paired you). */
    'cipher.me': { at: number };
    /** To everyone: counts moved (throttled); projector and console refetch. */
    'cipher.changed': { at: number };
    /** To everyone: the last signal was warned, fired, closed or revealed. */
    'cipher.signal': { status: z.infer<typeof SignalStatusSchema>; at: number };
  }
}
