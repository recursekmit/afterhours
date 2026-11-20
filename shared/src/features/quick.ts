// Quick session: turn "can we do a quick poll?" into a live activity in under two minutes.
//
// One organiser form per template (pick, fill, go live), orchestrated server side across schedule, polls,
// drops, attendance, morse, hunt and alerts. A session remembers what it created so it can be ended,
// undone, re-run or saved as a preset. Everything here is pure (schemas, limits and the paste parsers),
// so the console, the speaker view and the tests share one definition.
import { z } from 'zod';

// ---- limits -----------------------------------------------------------------

export const QUICK_LIMITS = {
  questionMax: 140,
  optionMax: 60,
  optionsMin: 2,
  optionsMax: 6,
  quizQuestionsMax: 5,
  huntStopsMin: 2,
  huntStopsMax: 5,
  labelMax: 60,
  nameMax: 60,
} as const;

export const TEMPLATE_IDS = ['poll', 'wordcloud', 'quiz', 'code', 'speed', 'room', 'morse', 'checkin', 'hunt', 'announce'] as const;
export const TemplateIdSchema = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

// ---- the paste parsers ---------------------------------------------------------

const BULLET = /^\s*(?:[-*•+]|\(?[a-zA-Z0-9]{1,2}[.)])\s+/;

/** Options pasted as lines. Bullets and numbering are dropped; blanks and duplicates too. */
export function parseOptionsPaste(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(BULLET, '').trim();
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}

export interface QuizQuestionDraft {
  question: string;
  options: string[];
  /** Index of the option marked with a leading `*`, or -1 when none (or several) was marked. */
  correct: number;
}

/**
 * A quiz pasted as blocks separated by a blank line:
 *   What does HTTP 404 mean?
 *   *not found
 *   forbidden
 *   teapot
 * The first line is the question, the `*` line is the right answer.
 */
export function parseQuizPaste(text: string): { questions: QuizQuestionDraft[]; problems: string[] } {
  const blocks = text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0);
  const problems: string[] = [];
  const questions: QuizQuestionDraft[] = [];
  blocks.forEach((lines, i) => {
    const [head, ...rest] = lines;
    const question = (head ?? '').replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):-]\s*/i, '').trim();
    const options: string[] = [];
    const stars: number[] = [];
    for (const l of rest) {
      const star = /^\*+\s*/.test(l);
      const label = l.replace(/^\*+\s*/, '').replace(BULLET, '').trim();
      if (!label) continue;
      if (star) stars.push(options.length);
      options.push(label);
    }
    const n = i + 1;
    if (options.length < 2) problems.push(`question ${n}: needs at least 2 options under it`);
    else if (stars.length === 0) problems.push(`question ${n}: mark the right answer with a * in front`);
    else if (stars.length > 1) problems.push(`question ${n}: only one answer can be right`);
    questions.push({ question, options, correct: stars.length === 1 ? (stars[0] as number) : -1 });
  });
  if (questions.length === 0) problems.push('paste at least one question');
  return { questions, problems };
}

export interface HuntStopDraft {
  clue: string;
  /** Riddle answer. Empty: a printed QR sticker has to be scanned. */
  answer: string;
}

/** Hunt stops pasted one per line: `clue => answer` for a riddle, `clue` alone for a QR sticker. */
export function parseHuntPaste(text: string): HuntStopDraft[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [clue = '', ...ans] = l.split(/\s*(?:=>|->|::)\s*/);
      return { clue: clue.trim(), answer: ans.join(' ').trim() };
    });
}

// ---- template specs ------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'No control characters');

const question = text(QUICK_LIMITS.questionMax).min(3, 'Type the question.');
const optionList = z
  .array(text(QUICK_LIMITS.optionMax))
  .transform((a) => a.filter((s) => s.length > 0))
  .pipe(z.array(z.string()).min(QUICK_LIMITS.optionsMin, 'Give at least 2 options (no empty ones).').max(QUICK_LIMITS.optionsMax, 'At most 6 options.'));

export const PollSpecSchema = z
  .object({
    template: z.literal('poll'),
    style: z.enum(['choice', 'this_or_that', 'rating']).default('choice'),
    question,
    options: z.array(text(QUICK_LIMITS.optionMax)).default([]),
    /** Rating style: the top of the scale. */
    ratingMax: z.union([z.literal(5), z.literal(7), z.literal(10)]).default(5),
  })
  .superRefine((v, ctx) => {
    if (v.style === 'rating') return;
    const n = v.options.filter((s) => s.trim().length > 0).length;
    const want = v.style === 'this_or_that' ? 2 : null;
    if (want !== null && n !== want) ctx.addIssue({ code: 'custom', path: ['options'], message: 'This-or-that needs exactly 2 options (no empty ones).' });
    else if (want === null && (n < QUICK_LIMITS.optionsMin || n > QUICK_LIMITS.optionsMax))
      ctx.addIssue({ code: 'custom', path: ['options'], message: n < QUICK_LIMITS.optionsMin ? 'Give at least 2 options (no empty ones).' : 'At most 6 options.' });
    if (v.options.some((s) => s.trim().length === 0) && n > 0) ctx.addIssue({ code: 'custom', path: ['options'], message: 'An option is empty. Fill it or remove it.' });
  });

export const WordcloudSpecSchema = z.object({
  template: z.literal('wordcloud'),
  question,
  maxWords: z.number().int().min(1).max(3).default(1),
});

export const QuizQuestionSchema = z
  .object({
    question,
    options: optionList,
    correct: z.number().int().min(0, 'Mark the right answer.'),
  })
  .refine((q) => q.correct < q.options.length, { message: 'Mark the right answer.', path: ['correct'] });
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const QuizSpecSchema = z.object({
  template: z.literal('quiz'),
  questions: z.array(QuizQuestionSchema).min(1, 'Add a question.').max(QUICK_LIMITS.quizQuestionsMax, 'At most 5 questions in a quick quiz.'),
  /** Seconds on the clock per question. */
  secondsPerQuestion: z.number().int().min(5).max(120).default(20),
  basePoints: z.number().int().min(0).max(200).default(20),
  speedBonus: z.number().int().min(0).max(200).default(20),
});

export const CodeSpecSchema = z.object({
  template: z.literal('code'),
  /** Empty: the server makes one up. */
  code: z
    .string()
    .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().max(12, 'At most 12 letters or digits.').refine((s) => s.length === 0 || s.length >= 2, 'At least 2 letters or digits.'))
    .default(''),
  display: z.enum(['plain', 'morse']).default('plain'),
  winners: z.number().int().min(1).max(300).default(7),
  windowSec: z.number().int().min(10).max(600).default(60),
  winPoints: z.number().int().min(1).max(100).default(15),
  restPoints: z.number().int().min(0).max(50).default(3),
});

export const SpeedSpecSchema = z
  .object({
    template: z.literal('speed'),
    question,
    /** Empty: a typed answer. 2 to 4: tap one. */
    choices: z.array(text(48)).max(4).default([]),
    /** Choice questions: which one is right. */
    correct: z.number().int().min(0).max(3).nullable().default(null),
    /** Typed questions: accepted spellings. */
    answers: z.array(text(40)).max(6).default([]),
    windowSec: z.number().int().min(10).max(600).default(45),
    topPoints: z.number().int().min(1).max(100).default(30),
  })
  .superRefine((v, ctx) => {
    const choices = v.choices.filter((s) => s.length > 0);
    if (choices.length === 1) ctx.addIssue({ code: 'custom', path: ['choices'], message: 'Give 2 to 4 choices, or none for a typed answer.' });
    if (choices.length >= 2 && (v.correct === null || v.correct >= choices.length)) ctx.addIssue({ code: 'custom', path: ['correct'], message: 'Tap the right choice.' });
    if (choices.length === 0 && !v.answers.some((a) => a.replace(/[^a-zA-Z0-9]/g, '').length > 0)) ctx.addIssue({ code: 'custom', path: ['answers'], message: 'Type the accepted answer.' });
  });

export const RoomSpecSchema = z.object({
  template: z.literal('room'),
  /** What the room is doing, shown on the drop ("everyone react"). */
  title: text(60).default('everyone react'),
  goal: z.number().int().min(10).max(10_000).default(43),
  windowSec: z.number().int().min(10).max(600).default(60),
  points: z.number().int().min(1).max(50).default(5),
});

export const MorseSpecSchema = z.object({
  template: z.literal('morse'),
  mode: z.enum(['decode', 'encode']).default('decode'),
  level: z.number().int().min(1).max(5).default(1),
  durationSec: z.number().int().min(30).max(600).default(300),
});

export const CheckinSpecSchema = z.object({
  template: z.literal('checkin'),
  /** An existing run of show activity. Empty: an unplanned session is created. */
  activityId: z.number().int().positive().nullable().default(null),
  /** Close the window by itself after this many minutes (0: stays open until closed). */
  closeAfterMin: z.number().int().min(0).max(240).default(15),
});

export const HuntStopSchema = z.object({
  clue: text(400).min(3, 'Each stop needs a clue.'),
  answer: text(60).default(''),
});
export const HuntSpecSchema = z.object({
  template: z.literal('hunt'),
  title: text(60).min(1, 'Name the hunt.'),
  stops: z.array(HuntStopSchema).min(QUICK_LIMITS.huntStopsMin, 'A hunt needs at least 2 stops.').max(QUICK_LIMITS.huntStopsMax, 'At most 5 stops in a quick hunt.'),
  pointsPerStop: z.number().int().min(1).max(50).default(10),
});

export const AnnounceSpecSchema = z.object({
  template: z.literal('announce'),
  title: text(60).min(1).default('heads up'),
  body: text(200).min(1, 'Type the message.'),
  push: z.boolean().default(true),
});

export const QuickSpecSchema = z.discriminatedUnion('template', [
  PollSpecSchema,
  WordcloudSpecSchema,
  QuizSpecSchema,
  CodeSpecSchema,
  SpeedSpecSchema,
  RoomSpecSchema,
  MorseSpecSchema,
  CheckinSpecSchema,
  HuntSpecSchema,
  AnnounceSpecSchema,
]);
export type QuickSpec = z.output<typeof QuickSpecSchema>;
export type QuickSpecInput = z.input<typeof QuickSpecSchema>;
export type SpecOf<T extends TemplateId> = Extract<QuickSpec, { template: T }>;

/** What every template shares: who it is for, whether it joins the run of show, whether to shout about it. */
export const CommonSchema = z.object({
  /** Speaker or session: titles the schedule activity and the history row. */
  label: text(QUICK_LIMITS.labelMax).default(''),
  addToRunOfShow: z.boolean().default(false),
  /** Minutes the schedule activity runs for. null: a sensible default per template. */
  durationMin: z.number().int().min(1).max(180).nullable().default(null),
  announce: z.boolean().default(false),
  /** Banner text. Empty: "<template> live now". */
  announceText: text(200).default(''),
  push: z.boolean().default(true),
});
export type Common = z.output<typeof CommonSchema>;
export type CommonInput = z.input<typeof CommonSchema>;

// ---- requests --------------------------------------------------------------------

const keySchema = z.string().trim().min(8).max(80);

/** POST /api/quick/go and POST /api/quick/queue. The key makes a double press harmless. */
export const GoRequestSchema = z.object({
  key: keySchema,
  spec: QuickSpecSchema,
  common: CommonSchema.default({ label: '', addToRunOfShow: false, durationMin: null, announce: false, announceText: '', push: true }),
  /** Another poll / drop / sprint is live: end it first instead of refusing. */
  closeLive: z.boolean().default(false),
  presetId: z.number().int().positive().nullable().default(null),
});
export type GoRequest = z.input<typeof GoRequestSchema>;

/** POST /api/quick/presets/:id/go and POST /api/quick/sessions/:id/rerun */
export const ShortcutGoRequestSchema = z.object({
  key: keySchema,
  closeLive: z.boolean().default(false),
  /** The speaker view overrides who the preset is for. */
  label: text(QUICK_LIMITS.labelMax).optional(),
});
export type ShortcutGoRequest = z.input<typeof ShortcutGoRequestSchema>;

export const SessionActionSchema = z.enum(['close', 'reveal', 'next', 'end', 'extend', 'undo']);
export type SessionAction = z.infer<typeof SessionActionSchema>;
export const SessionActionRequestSchema = z.object({ action: SessionActionSchema });

/** POST /api/quick/presets */
export const PresetInputSchema = z.object({
  name: text(QUICK_LIMITS.nameMax).min(1, 'Name the preset.'),
  spec: QuickSpecSchema,
  common: CommonSchema.default({ label: '', addToRunOfShow: false, durationMin: null, announce: false, announceText: '', push: true }),
});
export type PresetInput = z.input<typeof PresetInputSchema>;

// ---- what the console sees --------------------------------------------------------

export const SessionStatusSchema = z.enum(['queued', 'live', 'ended', 'undone']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionRefsSchema = z.object({
  activityId: z.number().int().optional(),
  /** The activity was made by this session (so undo may delete it). */
  activityMade: z.boolean().optional(),
  pollIds: z.array(z.number().int()).optional(),
  /** Quiz: index of the question on the air. */
  cursor: z.number().int().optional(),
  dropId: z.number().int().optional(),
  sprintId: z.number().int().optional(),
  trailId: z.number().int().optional(),
  checkinActivityId: z.string().optional(),
  bannerId: z.number().int().optional(),
  /** Something this session had to take down to launch (named for the log). */
  displaced: z.string().optional(),
  /** The projector pin that was cleared so the takeover could show. */
  unpinned: z.string().optional(),
  /** What the organiser needs to know that is not a failure ("push is off"). */
  notes: z.array(z.string()).optional(),
});
export type SessionRefs = z.infer<typeof SessionRefsSchema>;

export const SessionSchema = z.object({
  id: z.number().int(),
  template: TemplateIdSchema,
  title: z.string(),
  status: SessionStatusSchema,
  spec: QuickSpecSchema,
  common: CommonSchema,
  refs: SessionRefsSchema,
  presetId: z.number().int().nullable(),
  createdAt: z.number().int(),
  liveAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const PresetSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  template: TemplateIdSchema,
  spec: QuickSpecSchema,
  common: CommonSchema,
  builtin: z.boolean(),
  createdAt: z.number().int(),
});
export type Preset = z.infer<typeof PresetSchema>;

export const ControlSchema = z.enum(['close', 'reveal', 'next', 'end', 'extend', 'undo']);
export type Control = z.infer<typeof ControlSchema>;

export const LiveViewSchema = z.object({
  session: SessionSchema,
  /** Where it stands: 'live', 'closed' (poll waiting for reveal), 'revealed', 'done', 'queued', 'undone'. */
  phase: z.string(),
  headline: z.string(),
  detail: z.string(),
  stats: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) })),
  bars: z.array(z.object({ label: z.string(), value: z.number(), mark: z.boolean().optional() })),
  words: z.array(z.object({ word: z.string(), count: z.number().int() })),
  /** The thing on the projector that people type or decode, shown to the organiser too. */
  code: z.string().nullable(),
  /** Server epoch ms: when it ends by itself. */
  endsAt: z.number().int().nullable(),
  controls: z.array(ControlSchema),
  trailId: z.number().int().nullable(),
  serverNow: z.number().int(),
});
export type LiveView = z.infer<typeof LiveViewSchema>;

export const OverviewSchema = z.object({
  serverNow: z.number().int(),
  /** People signed in: the room's size. */
  present: z.number().int(),
  sizing: z.object({ codeWinners: z.number().int(), roomGoal: z.number().int() }),
  /** What is already on the air, so the form can warn before it collides. */
  busy: z.object({
    poll: z.string().nullable(),
    drop: z.string().nullable(),
    morse: z.string().nullable(),
    activity: z.string().nullable(),
    pinned: z.string().nullable(),
  }),
  /** The run of show, for the check-in picker. */
  activities: z.array(z.object({ id: z.number().int(), title: z.string(), status: z.string() })),
  live: z.array(SessionSchema),
  history: z.array(SessionSchema),
  presets: z.array(PresetSchema),
});
export type Overview = z.infer<typeof OverviewSchema>;

/** The 409 detail the form turns into "close it and launch this". */
export const CONFLICT_CODES = ['poll_live', 'drop_live', 'morse_live'] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

declare module '../live' {
  interface LiveEvents {
    /** To the console: a quick session was created, went live, changed or ended. Refetch. */
    'quick.changed': { at: number };
  }
}

// ---- helpers the form and the server share ------------------------------------------

export const TEMPLATE_TITLES: Record<TemplateId, string> = {
  poll: 'quick poll',
  wordcloud: 'word cloud',
  quiz: 'pop quiz',
  code: 'code drop',
  speed: 'speed question',
  room: 'everyone react',
  morse: 'morse speed round',
  checkin: 'check-in',
  hunt: 'mini hunt',
  announce: 'announcement',
};

/** Minutes a schedule activity runs for when the organiser did not say. */
export function defaultDurationMin(spec: QuickSpec): number {
  switch (spec.template) {
    case 'quiz':
      return Math.max(3, Math.ceil((spec.questions.length * (spec.secondsPerQuestion + 25)) / 60));
    case 'code':
    case 'speed':
    case 'room':
      return Math.max(2, Math.ceil(spec.windowSec / 60) + 1);
    case 'morse':
      return Math.ceil(spec.durationSec / 60);
    case 'checkin':
      return 15;
    case 'hunt':
      return 15;
    case 'announce':
      return 1;
    default:
      return 5;
  }
}

/** Title for the schedule activity and the history row: "<speaker>: <what>" when a speaker is named. */
export function sessionTitle(spec: QuickSpec, label: string): string {
  const what =
    spec.template === 'hunt' || spec.template === 'announce'
      ? spec.title
      : spec.template === 'room'
        ? spec.title || TEMPLATE_TITLES.room
        : TEMPLATE_TITLES[spec.template];
  return (label.trim() ? `${label.trim()}: ${what}` : what).slice(0, 80);
}

/** Make a code a person can say out loud: no 0/O, 1/I/L, 5/S, 8/B. */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY2346789';
export function randomCode(length = 5, rnd: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(rnd() * CODE_ALPHABET.length)];
  return out;
}
