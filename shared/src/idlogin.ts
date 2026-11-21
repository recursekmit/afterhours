/*
  Student-ID login (spec 4.1): the roster of registered participants, the QR
  printed on the KMIT student ID card, and how a scan resolves to one person.

  The card's QR looks like  055W-12600-C-DATTA-CSE-250908
    055W    last four characters of the roll (26BD1A055W), the primary key
    12600   a number (unknown meaning, ignored)
    C       section letter
    DATTA   surname
    CSE     branch
    250908  a date, probably yyMMdd; its yy likely matches the roll's batch (25BD1A...)
  Everything after the first segment is a hint, never a fact.
*/
import { z } from 'zod';

/* ------------------------------------------------------------- rolls */

/** KMIT roll shape after normalising: 26BD1A055W (batch, college, 1, A, branch code, serial). */
export const KMIT_ROLL_RE = /^\d{2}[A-Z]{2}\d[A-Z]\d{2}[A-Z0-9]{2}$/;
/** Any roll we accept (walk-ins from elsewhere too): letters and digits only. */
export const ROLL_RE = /^[A-Z0-9]{4,16}$/;

/** Positions in a 10-character KMIT roll that are always digits. */
const DIGIT_POSITIONS = [0, 1, 4, 6, 7];

/**
 * "26bd1a o55w", "26-BD1A-055W", "26BD1AO55W" -> "26BD1A055W".
 * Uppercases, drops spaces and separators, and turns a typed letter O into a
 * zero where a KMIT roll always has a digit. Returns '' for nothing usable.
 */
export function normaliseRoll(input: string): string {
  const s = input.toUpperCase().replace(/[\s\-_./\\,:;|]+/g, '');
  if (s.length !== 10) return s;
  const chars = [...s];
  for (const i of DIGIT_POSITIONS) if (chars[i] === 'O') chars[i] = '0';
  return chars.join('');
}

/** Matching key: O and 0 are the same everywhere, so a typo in the serial still finds the roll. */
export function rollKey(roll: string): string {
  return normaliseRoll(roll).replace(/O/g, '0');
}

/** The last four characters of a roll: what the ID card's QR starts with. */
export function rollSuffix(roll: string): string {
  return rollKey(roll).slice(-4);
}

/** Only the digits of a phone number, without a leading +91 / 91 / 0 country or trunk code. */
export function phoneDigits(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '');
}

export function phoneLast4(input: string | null | undefined): string {
  return phoneDigits(input).slice(-4);
}

/* ---------------------------------------------------------- QR payload */

export interface IdQr {
  /** The 4-character roll suffix (O fixed to 0 where the roll has digits). */
  suffix: string;
  /** A full roll, if the payload carried one instead of (or as well as) the suffix. */
  roll: string | null;
  number: string | null;
  section: string | null;
  surname: string | null;
  branch: string | null;
  /** The raw date segment, yyMMdd. */
  date: string | null;
  /** Two-digit batch year read from the date (the "25" of 250908). */
  batch: string | null;
}

const BRANCHES = new Set(['CSE', 'CSM', 'CSD', 'CSO', 'CSC', 'CSB', 'CS', 'IT', 'ECE', 'EEE', 'EIE', 'MECH', 'ME', 'CIVIL', 'CE', 'AIML', 'AIDS', 'AI', 'DS', 'CSAI', 'CSIT']);

function fixSuffix(s: string): string {
  // The suffix is roll positions 6..9: two digits (branch code), then a serial.
  const chars = [...s];
  for (const i of [0, 1]) if (chars[i] === 'O') chars[i] = '0';
  return chars.join('');
}

const SUFFIX_RE = /^[0-9O]{2}[A-Z0-9]{2}$/;

function dateBatch(tok: string): { date: string; batch: string } | null {
  // yyMMdd, or yyyyMMdd
  const six = tok.length === 8 && /^20\d{6}$/.test(tok) ? tok.slice(2) : tok;
  if (!/^\d{6}$/.test(six)) return null;
  const mm = Number(six.slice(2, 4));
  const dd = Number(six.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { date: six, batch: six.slice(0, 2) };
}

/**
 * Read a student-ID QR. Liberal: any separators (or spaces), any case, a full
 * roll anywhere, segments in the expected order or not. Returns null for
 * anything that is not a student ID (a URL, a kit QR, a stall code, junk).
 */
/**
 * A KMIT roll written anywhere in a longer text ("ROLL NO:26BD1A053G", "...?roll=26bd1a053g&..."), including
 * the letter O typed for a zero in the digit positions. Returns the normalised roll or null.
 */
export function findEmbeddedRoll(upperText: string): string | null {
  const re = /(?:^|[^A-Z0-9])([0-9O]{2}[A-Z]{2}[0-9O][A-Z][0-9O]{2}[A-Z0-9]{2})(?=$|[^A-Z0-9])/g;
  for (const m of upperText.matchAll(re)) {
    const r = normaliseRoll(m[1] ?? '');
    if (KMIT_ROLL_RE.test(r)) return r;
  }
  return null;
}

export function parseIdQr(raw: string): IdQr | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toUpperCase();
  if (!text || text.length > 4000) return null;
  // ID cards differ by batch: 2nd year cards carry "055W-12600-C-NAME-CSE-250908"; other batches carry longer
  // payloads (details, or a link). A full roll number anywhere in the payload always wins.
  const embedded = findEmbeddedRoll(text);
  if (/^[A-Z][A-Z0-9+.-]*:\/\//.test(text) && !embedded) return null; // a URL with no roll: kit cards, stall QRs
  const tokens = text.split(/[^A-Z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let roll: string | null = embedded;
  if (!roll) {
    for (const t of tokens) {
      const r = normaliseRoll(t);
      if (KMIT_ROLL_RE.test(r)) {
        roll = r;
        break;
      }
    }
  }
  if (roll) {
    // A payload that names the roll outright: no guessing from the first segment.
    return { suffix: roll.slice(-4), roll, number: null, section: null, surname: null, branch: null, date: null, batch: null };
  }

  let suffix: string | null = null;
  let rest = tokens;
  const first = tokens[0] ?? '';
  if (SUFFIX_RE.test(first)) {
    suffix = fixSuffix(first);
    rest = tokens.slice(1);
  } else if (roll) {
    suffix = roll.slice(-4);
    rest = tokens.filter((t) => normaliseRoll(t) !== roll);
  } else if (tokens.length === 1 && first.length > 10) {
    // No separators at all: 055W12600CDATTACSE250908
    const m = /^([0-9O]{2}[A-Z0-9]{2})(\d{3,7}?)([A-Z])([A-Z]{2,}?)(CSE|CSM|CSD|CSO|IT|ECE|EEE|AIML|AIDS|DS)?(\d{6}|20\d{6})$/.exec(first);
    if (!m) return null;
    rest = [m[2], m[3], m[4], m[5], m[6]].filter((x): x is string => Boolean(x));
    suffix = fixSuffix(m[1] ?? '');
  }
  if (!suffix) return null;
  // A student ID has more than the suffix; a lone 4-character string is not one.
  if (!roll && rest.length === 0) return null;

  const out: IdQr = { suffix, roll, number: null, section: null, surname: null, branch: null, date: null, batch: null };
  // The date is the last all-digit segment that reads as a date; the number is the first other one.
  let dateAt = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    const d = dateBatch(rest[i] ?? '');
    if (d) {
      out.date = d.date;
      out.batch = d.batch;
      dateAt = i;
      break;
    }
  }
  const words: string[] = [];
  for (const [i, t] of rest.entries()) {
    if (i === dateAt) continue;
    if (/^\d+$/.test(t)) out.number ??= t;
    else if (/^[A-Z]$/.test(t) && out.section === null) out.section = t;
    else if (/^[A-Z]+$/.test(t) && BRANCHES.has(t) && out.branch === null) out.branch = t;
    else if (/^[A-Z]{2,}$/.test(t)) words.push(t);
  }
  if (words.length) out.surname = words.join(' ');
  return out;
}

/* ------------------------------------------------------------ resolve */

export interface RosterCandidate {
  roll: string;
}

export type Resolution<T extends RosterCandidate> = { kind: 'one'; who: T } | { kind: 'many'; candidates: T[] } | { kind: 'none' };

/**
 * Who a scanned card could be. Names, surnames and the date segment are NOT
 * used: registrations often carry only a first or shortened name, which would
 * not match the card's official one. Simple and predictable:
 *   a full roll in the QR -> that roll, exactly;
 *   otherwise the first segment is the roll's last four:
 *     one registered participant with it -> them ("that's you?");
 *     two or more                        -> the phone shows a "who are you?" picker;
 *     none                               -> not on the list.
 */
export function resolveIdQr<T extends RosterCandidate>(qr: IdQr, roster: readonly T[]): Resolution<T> {
  const cands = qr.roll ? roster.filter((p) => rollKey(p.roll) === rollKey(qr.roll ?? '')) : roster.filter((p) => rollSuffix(p.roll) === rollKey(qr.suffix));
  if (cands.length === 0) return { kind: 'none' };
  if (cands.length === 1) return { kind: 'one', who: cands[0] as T };
  // The card's format tells the batch: the short "055W-12600-C-NAME-CSE-250908" cards end in their issue
  // date (25... = the 25BD1A batch). When that narrows a shared last-four to one person, no picker is needed.
  if (qr.batch) {
    const sameBatch = cands.filter((p) => rollKey(p.roll).startsWith(qr.batch ?? ''));
    if (sameBatch.length === 1) return { kind: 'one', who: sameBatch[0] as T };
    if (sameBatch.length > 1) return { kind: 'many', candidates: sameBatch };
  }
  return { kind: 'many', candidates: cands };
}

/* ---------------------------------------------------------- roster CSV */

export interface ParticipantInput {
  name: string;
  year: string | null;
  section: string | null;
  roll: string;
  phone: string | null;
  email: string | null;
}

/** Names that look like a test entry, not a person: listed in the import report. */
export function looksLikeTestEntry(name: string): boolean {
  return /\b(test|testing|trial|demo|dummy|sample|asdf|xyz)\b/i.test(name);
}

/* ------------------------------------------------------------- schemas */

const RollInputSchema = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const r = normaliseRoll(v);
    if (!ROLL_RE.test(r)) {
      ctx.addIssue({ code: 'custom', message: 'That roll number looks off. It is on your ID card, like 26BD1A0501.' });
      return z.NEVER;
    }
    return r;
  });

const Phone4Schema = z
  .string()
  .max(12)
  .transform((v, ctx) => {
    const d = v.replace(/\D/g, '');
    if (d.length !== 4) {
      ctx.addIssue({ code: 'custom', message: 'The last 4 digits of your phone number.' });
      return z.NEVER;
    }
    return d;
  });

/** Phone: a scanned ID card. `pick` is the participant tapped in the "who are you?" picker. */
export const IdResolveRequestSchema = z.object({
  payload: z.string().min(1).max(300),
  pick: z.number().int().positive().optional(),
});
export type IdResolveRequest = z.input<typeof IdResolveRequestSchema>;

/** One person in the picker: only what tells people apart. Never a roll, phone or email. */
export const IdPickChoiceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  year: z.string().nullable(),
  section: z.string().nullable(),
  /** Already signed in on another phone: listed, but not pickable. */
  bound: z.boolean(),
});
export type IdPickChoice = z.infer<typeof IdPickChoiceSchema>;

export const IdResolveResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('one'),
    id: z.number().int(),
    /** First name only, for "hi Kashvi! that's you?". */
    firstName: z.string(),
    year: z.string().nullable(),
    section: z.string().nullable(),
    /** The console asks for the last 4 phone digits after a scan. */
    needPhone: z.boolean(),
    /** This phone is already the one this ID is bound to. */
    thisPhone: z.boolean(),
  }),
  z.object({ kind: z.literal('pick'), choices: z.array(IdPickChoiceSchema) }),
]);
export type IdResolveResponse = z.infer<typeof IdResolveResponseSchema>;

export const IdSignInRequestSchema = z.object({
  payload: z.string().min(1).max(300),
  pick: z.number().int().positive().optional(),
  phone4: Phone4Schema.optional(),
});
export type IdSignInRequest = z.input<typeof IdSignInRequestSchema>;

/** Typed fallback: full roll + last 4 digits of the registered phone. */
export const RollSignInRequestSchema = z.object({
  roll: RollInputSchema,
  phone4: Phone4Schema,
});
export type RollSignInRequest = z.input<typeof RollSignInRequestSchema>;

/* -------------------------------------------------------------- console */

const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const ParticipantInputSchema = z.object({
  name: z.string().trim().min(1, 'a name please').max(80),
  roll: RollInputSchema,
  year: opt(20),
  section: opt(20),
  phone: opt(20),
  email: opt(120),
  note: opt(200),
});
export type ParticipantInputBody = z.input<typeof ParticipantInputSchema>;

export const ParticipantRowSchema = z.object({
  id: z.number().int(),
  roll: z.string(),
  name: z.string(),
  year: z.string().nullable(),
  section: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** Desk notes: duplicate rolls, probable test entries, walk-in. */
  note: z.string(),
  source: z.enum(['import', 'walkin']),
  kitId: z.string(),
  createdAt: z.number(),
  /** Bound to a phone right now. */
  bound: z.boolean(),
  resets: z.number().int(),
  /** Epoch ms when a coordinator let this person in at /gate, or null. */
  gateEnteredAt: z.number().nullable(),
  attendee: z
    .object({
      id: z.number().int(),
      nickname: z.string().nullable(),
      firstSignInAt: z.number(),
      profileComplete: z.boolean(),
      points: z.number().int(),
    })
    .nullable(),
});
export type ParticipantRow = z.infer<typeof ParticipantRowSchema>;

export const ParticipantListResponseSchema = z.object({
  participants: z.array(ParticipantRowSchema),
  stats: z.object({ total: z.number(), signedIn: z.number(), bound: z.number() }),
  settings: z.object({ strictPhone: z.boolean() }),
});
export type ParticipantListResponse = z.infer<typeof ParticipantListResponseSchema>;

export const ImportParticipantsRequestSchema = z.object({ csv: z.string().min(1).max(500_000) });

export const ImportReportSchema = z.object({
  added: z.number().int(),
  /** Rows read (not counting blanks and a header). */
  rows: z.number().int(),
  /** Same roll again with the same name and phone: dropped quietly. */
  duplicates: z.array(z.object({ line: z.number(), roll: z.string(), name: z.string() })),
  /** Same roll with a different name or phone: the first is kept, these are listed for the desk. */
  conflicts: z.array(
    z.object({ line: z.number(), roll: z.string(), name: z.string(), keptName: z.string(), differs: z.array(z.enum(['name', 'phone'])), existing: z.boolean() }),
  ),
  /** Already on the list before this import (same name and phone). */
  existing: z.number().int(),
  skipped: z.array(z.object({ line: z.number(), reason: z.string() })),
  /** Imported, but worth a look: probable test entries. */
  flagged: z.array(z.object({ roll: z.string(), name: z.string(), reason: z.string() })),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

export const ParticipantSettingsSchema = z.object({ strictPhone: z.boolean() });
export type ParticipantSettings = z.infer<typeof ParticipantSettingsSchema>;

/** Desk lookup: a scanned card, a roll, part of a roll or a name. */
export const DeskLookupRequestSchema = z.object({ q: z.string().trim().min(1).max(300) });
export const DeskLookupResponseSchema = z.object({
  /** How the query was read. */
  read: z.enum(['qr', 'roll', 'search']),
  qr: z
    .object({ suffix: z.string(), surname: z.string().nullable(), batch: z.string().nullable(), section: z.string().nullable(), branch: z.string().nullable() })
    .nullable(),
  /** The person the phone would sign in as for this scan, if exactly one. */
  pickId: z.number().int().nullable(),
  matches: z.array(ParticipantRowSchema),
});
export type DeskLookupResponse = z.infer<typeof DeskLookupResponseSchema>;

/**
 * POST /api/admin/participants/:id/purge (console): remove a mock tester and every trace of what they did.
 * `confirm` must be their roll number, typed out.
 */
export const PurgeRequestSchema = z.object({ confirm: z.string().trim().min(1).max(40) });
export type PurgeRequest = z.input<typeof PurgeRequestSchema>;
export const PurgeReportSchema = z.object({
  participantId: z.number().int(),
  roll: z.string(),
  attendeeId: z.number().int().nullable(),
  nickname: z.string().nullable(),
  /** rows removed (or released) per table */
  rows: z.record(z.string(), z.number().int()),
});
export type PurgeReport = z.infer<typeof PurgeReportSchema>;

/* ----------------------------------------------------------------- gate */

/** One registered participant as shown to a door coordinator at /gate (no full phone or email). */
export const GatePersonSchema = z.object({
  id: z.number().int(),
  roll: z.string(),
  name: z.string(),
  year: z.string().nullable(),
  section: z.string().nullable(),
  phoneLast4: z.string().nullable(),
  note: z.string(),
  signedIn: z.boolean(),
  gateEnteredAt: z.number().nullable(),
});
export type GatePerson = z.infer<typeof GatePersonSchema>;

export const GateCountSchema = z.object({
  total: z.number().int(),
  entered: z.number().int(),
});
export type GateCount = z.infer<typeof GateCountSchema>;

export const GateRecentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  roll: z.string(),
  year: z.string().nullable(),
  section: z.string().nullable(),
  gateEnteredAt: z.number(),
});
export type GateRecent = z.infer<typeof GateRecentSchema>;

export const GateStatsSchema = z.object({
  total: z.number().int(),
  entered: z.number().int(),
  recent: z.array(GateRecentSchema),
});
export type GateStats = z.infer<typeof GateStatsSchema>;

export const GateLookupRequestSchema = z.object({ q: z.string().trim().min(1).max(300) });
export const GateLookupResponseSchema = z.object({
  read: z.enum(['qr', 'roll', 'search']),
  qrSuffix: z.string().nullable(),
  matches: z.array(GatePersonSchema),
  stats: GateCountSchema,
});
export type GateLookupResponse = z.infer<typeof GateLookupResponseSchema>;

export const GateEnterResponseSchema = z.object({
  person: GatePersonSchema,
  /** true when this tap marked them entered; false when they were already marked in. */
  newlyEntered: z.boolean(),
  stats: GateCountSchema,
});
export type GateEnterResponse = z.infer<typeof GateEnterResponseSchema>;

export const GateUndoResponseSchema = z.object({
  person: GatePersonSchema,
  stats: GateCountSchema,
});
export type GateUndoResponse = z.infer<typeof GateUndoResponseSchema>;
