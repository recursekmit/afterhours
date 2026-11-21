/*
  The roster of registered participants (spec 4.1) and the console's tools for it.

  Data model: a participant is a roster row plus one synthetic "roster kit"
  (kits.kind = 'roster', id = their roll at the time they were added). The
  phone binds to that kit exactly like a printed card, and the first sign-in
  creates an ordinary attendee pointing at it. So attendeeId, kit_id and
  everything keyed on them (points, stickers, stalls, trails, per-kit slip
  words, the leaderboard) need no changes, and kits stay the walk-in fallback.
*/
import {
  type DeskLookupResponse,
  type GateCount,
  type GateEnterResponse,
  type GateLookupResponse,
  type GatePerson,
  type GateRecent,
  type GateStats,
  type GateUndoResponse,
  KMIT_ROLL_RE,
  type ImportReport,
  type ParticipantInput,
  type ParticipantListResponse,
  type ParticipantRow,
  ROLL_RE,
  looksLikeTestEntry,
  normaliseRoll,
  parseIdQr,
  phoneDigits,
  phoneLast4,
  resolveIdQr,
  rollKey,
  rollSuffix,
} from '@afterhours/shared';
import type { AppContext } from '../context';
import { all, one, run, tx } from '../db';
import { HttpError, conflict, notFound } from '../errors';
import { splitCsvLine, unbindKit } from './kits';

/* ---------------------------------------------------------------- read */

interface Joined {
  id: number;
  roll: string;
  name: string;
  year: string | null;
  section: string | null;
  phone: string | null;
  email: string | null;
  note: string;
  source: 'import' | 'walkin';
  kit_id: string;
  created_at: number;
  gate_entered_at: number | null;
  device_hash: string | null;
  resets: number;
  attendee_id: number | null;
  nickname: string | null;
  first_signin_at: number | null;
  profile_complete: number | null;
  points: number | null;
}

const SELECT = `
  SELECT p.id, p.roll, p.name, p.year, p.section, p.phone, p.email, p.note, p.source, p.kit_id, p.created_at, p.gate_entered_at,
         k.device_hash, k.resets,
         a.id AS attendee_id, a.nickname, a.first_signin_at, a.profile_complete,
         (SELECT COALESCE(SUM(l.points), 0) FROM points_ledger l WHERE l.attendee_id = a.id) AS points
    FROM participants p
    JOIN kits k ON k.id = p.kit_id
    LEFT JOIN attendees a ON a.kit_id = p.kit_id`;

function toRow(r: Joined): ParticipantRow {
  return {
    id: r.id,
    roll: r.roll,
    name: r.name,
    year: r.year,
    section: r.section,
    phone: r.phone,
    email: r.email,
    note: r.note,
    source: r.source,
    kitId: r.kit_id,
    createdAt: r.created_at,
    bound: r.device_hash !== null,
    resets: r.resets,
    gateEnteredAt: r.gate_entered_at,
    attendee:
      r.attendee_id === null
        ? null
        : {
            id: r.attendee_id,
            nickname: r.nickname,
            firstSignInAt: r.first_signin_at ?? 0,
            profileComplete: r.profile_complete === 1,
            points: r.points ?? 0,
          },
  };
}

export function getParticipant(ctx: AppContext, id: number): ParticipantRow {
  const r = one<Joined>(ctx.db, `${SELECT} WHERE p.id = ?`, id);
  if (!r) throw notFound('No such participant.');
  return toRow(r);
}

export function listParticipants(ctx: AppContext): ParticipantListResponse {
  const participants = all<Joined>(ctx.db, `${SELECT} ORDER BY p.name COLLATE NOCASE, p.roll`).map(toRow);
  return {
    participants,
    stats: {
      total: participants.length,
      signedIn: participants.filter((p) => p.attendee).length,
      bound: participants.filter((p) => p.bound).length,
    },
    settings: getIdLoginSettings(ctx),
  };
}

/** Everyone on the roster, light: for resolving a scan. A few hundred rows at most. */
export interface RosterEntry {
  id: number;
  roll: string;
  name: string;
  year: string | null;
  section: string | null;
  phone: string | null;
  kitId: string;
}

export function roster(ctx: AppContext): RosterEntry[] {
  return all<{ id: number; roll: string; name: string; year: string | null; section: string | null; phone: string | null; kit_id: string }>(
    ctx.db,
    'SELECT id, roll, name, year, section, phone, kit_id FROM participants ORDER BY name COLLATE NOCASE, id',
  ).map((r) => ({ id: r.id, roll: r.roll, name: r.name, year: r.year, section: r.section, phone: r.phone, kitId: r.kit_id }));
}

export function findByRoll(ctx: AppContext, roll: string): RosterEntry | null {
  const key = rollKey(roll);
  return roster(ctx).find((p) => rollKey(p.roll) === key) ?? null;
}

/**
 * 1st-year cards print the roll as KMBD1A053G ("KM" where the batch digits go). A typed roll matches a
 * registered one exactly, or, when either side is KM-prefixed, on everything after the first two characters.
 */
export function typedRollMatches(typed: string, registered: string): boolean {
  const a = rollKey(typed);
  const b = rollKey(registered);
  if (a === b) return true;
  return a.length === 10 && b.length === 10 && (a.startsWith('KM') || b.startsWith('KM')) && a.slice(2) === b.slice(2);
}

/** Everyone a typed roll could be: the exact roll, else the KM-prefixed matches (see typedRollMatches). */
export function findAllByTypedRoll(ctx: AppContext, roll: string): RosterEntry[] {
  const exact = findByRoll(ctx, roll);
  if (exact) return [exact];
  return roster(ctx).filter((p) => typedRollMatches(roll, p.roll));
}

/* ------------------------------------------------------------ settings */

const STRICT_KEY = 'idlogin.strictPhone';

export function getIdLoginSettings(ctx: AppContext): { strictPhone: boolean } {
  const v = one<{ value: string }>(ctx.db, 'SELECT value FROM core_kv WHERE key = ?', STRICT_KEY)?.value;
  return { strictPhone: v === '1' };
}

export function setIdLoginSettings(ctx: AppContext, s: { strictPhone: boolean }): { strictPhone: boolean } {
  run(
    ctx.db,
    'INSERT INTO core_kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    STRICT_KEY,
    s.strictPhone ? '1' : '0',
  );
  return getIdLoginSettings(ctx);
}

/* --------------------------------------------------------------- write */

/** A free kit id for this roll: the roll itself, or ROLL-2, ROLL-3... if an edited roll left it taken. */
function rosterKitId(ctx: AppContext, roll: string): string {
  for (let n = 1; ; n++) {
    const id = n === 1 ? roll : `${roll}-${n}`;
    if (!one(ctx.db, 'SELECT 1 AS x FROM kits WHERE id = ? COLLATE NOCASE', id)) return id;
  }
}

function insertParticipant(ctx: AppContext, p: ParticipantInput & { note?: string | null }, source: 'import' | 'walkin', now: number): number {
  const kitId = rosterKitId(ctx, p.roll);
  run(
    ctx.db,
    "INSERT INTO kits (id, password_hash, preset_name, preset_roll, created_at, kind) VALUES (?, '!roster', ?, ?, ?, 'roster')",
    kitId,
    p.name,
    p.roll,
    now,
  );
  return run(
    ctx.db,
    `INSERT INTO participants (roll, name, year, section, phone, email, note, source, kit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.roll,
    p.name,
    p.year,
    p.section,
    p.phone,
    p.email,
    p.note ?? '',
    source,
    kitId,
    now,
  ).lastId;
}

function assertRollFree(ctx: AppContext, roll: string, exceptId?: number) {
  const key = rollKey(roll);
  const clash = roster(ctx).find((p) => rollKey(p.roll) === key && p.id !== exceptId);
  if (clash) throw conflict(`${clash.roll} is already on the list (${clash.name}).`);
}

/** Console: add one person by hand (a walk-in, or someone the form missed). */
export function addParticipant(ctx: AppContext, p: ParticipantInput & { note?: string | null }, source: 'import' | 'walkin' = 'walkin'): ParticipantRow {
  assertRollFree(ctx, p.roll);
  const id = tx(ctx.db, () => insertParticipant(ctx, p, source, ctx.now()));
  return getParticipant(ctx, id);
}

/**
 * Console: fix someone's details. The roster kit keeps its id (it may already
 * carry slip words and history); its prefill name and roll follow the edit.
 */
export function updateParticipant(ctx: AppContext, id: number, p: ParticipantInput & { note?: string | null }): ParticipantRow {
  const cur = one<{ kit_id: string }>(ctx.db, 'SELECT kit_id FROM participants WHERE id = ?', id);
  if (!cur) throw notFound('No such participant.');
  assertRollFree(ctx, p.roll, id);
  tx(ctx.db, () => {
    run(
      ctx.db,
      'UPDATE participants SET roll = ?, name = ?, year = ?, section = ?, phone = ?, email = ?, note = ? WHERE id = ?',
      p.roll,
      p.name,
      p.year,
      p.section,
      p.phone,
      p.email,
      p.note ?? '',
      id,
    );
    run(ctx.db, 'UPDATE kits SET preset_name = ?, preset_roll = ? WHERE id = ?', p.name, p.roll, cur.kit_id);
  });
  return getParticipant(ctx, id);
}

/** Console: let this person sign in on another phone. Signs out the old one. */
export function unbindParticipant(ctx: AppContext, id: number): ParticipantRow {
  const cur = one<{ kit_id: string }>(ctx.db, 'SELECT kit_id FROM participants WHERE id = ?', id);
  if (!cur) throw notFound('No such participant.');
  unbindKit(ctx, cur.kit_id, 'id-reset');
  return getParticipant(ctx, id);
}

/**
 * Console: take someone off the list. Only before they have signed in: an
 * attendee with points cannot vanish mid-event (unbind them instead).
 */
export function removeParticipant(ctx: AppContext, id: number): void {
  const cur = one<{ kit_id: string }>(ctx.db, 'SELECT kit_id FROM participants WHERE id = ?', id);
  if (!cur) throw notFound('No such participant.');
  if (one(ctx.db, 'SELECT 1 AS x FROM attendees WHERE kit_id = ?', cur.kit_id)) {
    throw new HttpError(409, 'conflict', 'They have already signed in, so they stay (their points and stickers too). Use "unbind" to move them to another phone.');
  }
  tx(ctx.db, () => {
    run(ctx.db, 'DELETE FROM participants WHERE id = ?', id);
    run(ctx.db, "DELETE FROM kits WHERE id = ? AND kind = 'roster'", cur.kit_id);
  });
}

/* ---------------------------------------------------------- CSV import */

type Field = keyof ParticipantInput;
const DEFAULT_COLUMNS: Field[] = ['name', 'year', 'section', 'roll', 'phone', 'email'];
const HEADER_ALIASES: Record<string, Field> = {
  name: 'name',
  fullname: 'name',
  studentname: 'name',
  year: 'year',
  section: 'section',
  sec: 'section',
  class: 'section',
  roll: 'roll',
  rollno: 'roll',
  rollnumber: 'roll',
  hallticket: 'roll',
  hallticketno: 'roll',
  phone: 'phone',
  phoneno: 'phone',
  phonenumber: 'phone',
  mobile: 'phone',
  mobilenumber: 'phone',
  whatsapp: 'phone',
  whatsappnumber: 'phone',
  contact: 'phone',
  email: 'email',
  emailid: 'email',
  emailaddress: 'email',
  mail: 'email',
};

export interface ParsedParticipant {
  line: number;
  input: ParticipantInput;
}

/**
 * Parse a pasted or uploaded roster: name, year, section, roll, phone, email.
 * Commas or tabs (a spreadsheet paste), quoted fields, blank lines. A header
 * row, if present, decides the column order (and may name them loosely:
 * "Roll No", "Mobile Number"...); without one the order above is assumed.
 */
export function parseParticipantCsv(text: string): { rows: ParsedParticipant[]; skipped: { line: number; reason: string }[] } {
  const rows: ParsedParticipant[] = [];
  const skipped: { line: number; reason: string }[] = [];
  let columns: (Field | null)[] = DEFAULT_COLUMNS;
  let first = true;
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.includes('\t') ? '\t' : ',';
    const cells = splitCsvLine(raw.replace(/\s+$/, ''), sep).map((c) => c.trim());
    if (first) {
      first = false;
      const mapped = cells.map((c) => HEADER_ALIASES[c.toLowerCase().replace(/[^a-z]/g, '')] ?? null);
      if (mapped.includes('roll') && mapped.includes('name')) {
        columns = mapped;
        continue;
      }
    }
    const get = (f: Field): string => {
      const at = columns.indexOf(f);
      return at >= 0 ? (cells[at] ?? '').trim() : '';
    };
    const name = get('name').replace(/\s+/g, ' ');
    const roll = normaliseRoll(get('roll'));
    const reason = !name
      ? 'no name'
      : name.length > 80
        ? 'name too long'
        : !roll
          ? 'no roll number'
          : !ROLL_RE.test(roll)
            ? `odd roll number "${get('roll').slice(0, 24)}"`
            : null;
    if (reason) {
      skipped.push({ line: i + 1, reason });
      continue;
    }
    const opt = (f: Field, max: number) => get(f).slice(0, max) || null;
    rows.push({ line: i + 1, input: { name, roll, year: opt('year', 20), section: opt('section', 20), phone: opt('phone', 20), email: opt('email', 120) } });
  }
  return { rows, skipped };
}

const sameName = (a: string, b: string) => a.toUpperCase().replace(/[^A-Z]/g, '') === b.toUpperCase().replace(/[^A-Z]/g, '');
const samePhone = (a: string | null, b: string | null) => phoneDigits(a).slice(-10) === phoneDigits(b).slice(-10);
const last2 = (phone: string | null) => {
  const d = phoneDigits(phone);
  return d ? `phone ending ${d.slice(-2)}` : 'no phone';
};

/**
 * Import a roster. Dedupes by roll (O and 0 alike): the first row of a roll is
 * kept; a later row with the same name and phone is a duplicate, one with a
 * different name or phone is a conflict, listed and noted on the kept person
 * so the desk can sort it out. People already on the list are left as they are.
 */
export function importParticipants(ctx: AppContext, text: string): ImportReport {
  const { rows, skipped } = parseParticipantCsv(text);
  const report: ImportReport = { added: 0, rows: rows.length, duplicates: [], conflicts: [], existing: 0, skipped, flagged: [] };
  const before = new Map(
    all<{ id: number; roll: string; name: string; phone: string | null; note: string }>(ctx.db, 'SELECT id, roll, name, phone, note FROM participants').map((p) => [
      rollKey(p.roll),
      p,
    ]),
  );
  const fresh = new Map<string, ParsedParticipant & { notes: string[] }>();
  const existingNotes = new Map<number, string[]>();

  for (const row of rows) {
    const key = rollKey(row.input.roll);
    const kept = fresh.get(key)?.input ?? before.get(key);
    if (kept) {
      const differs: ('name' | 'phone')[] = [];
      if (!sameName(kept.name, row.input.name)) differs.push('name');
      if (!samePhone(kept.phone, row.input.phone)) differs.push('phone');
      const existing = !fresh.has(key);
      if (differs.length === 0) {
        if (existing) report.existing++;
        else report.duplicates.push({ line: row.line, roll: row.input.roll, name: row.input.name });
        continue;
      }
      report.conflicts.push({ line: row.line, roll: row.input.roll, name: row.input.name, keptName: kept.name, differs, existing });
      const note = `roll also given by "${row.input.name}" (${last2(row.input.phone)}): check at the desk`;
      const f = fresh.get(key);
      if (f) f.notes.push(note);
      else {
        const id = before.get(key)?.id;
        if (id !== undefined) existingNotes.set(id, [...(existingNotes.get(id) ?? []), note]);
      }
      continue;
    }
    const notes: string[] = [];
    if (looksLikeTestEntry(row.input.name)) {
      notes.push('probable test entry');
      report.flagged.push({ roll: row.input.roll, name: row.input.name, reason: 'probable test entry' });
    }
    fresh.set(key, { ...row, notes });
  }

  const now = ctx.now();
  tx(ctx.db, () => {
    for (const f of fresh.values()) insertParticipant(ctx, { ...f.input, note: f.notes.join('; ') }, 'import', now);
    for (const [id, notes] of existingNotes) {
      const cur = one<{ note: string }>(ctx.db, 'SELECT note FROM participants WHERE id = ?', id)?.note ?? '';
      const add = notes.filter((n) => !cur.includes(n));
      if (add.length) run(ctx.db, 'UPDATE participants SET note = ? WHERE id = ?', [cur, ...add].filter(Boolean).join('; '), id);
    }
  });
  report.added = fresh.size;
  return report;
}

/* ---------------------------------------------------------------- desk */

/**
 * Desk mode: a scanned card, a typed roll (full or part) or a name. Returns
 * everyone who matches, and for a scan, who the phone would sign in as.
 */
export function deskLookup(ctx: AppContext, q: string): DeskLookupResponse {
  const everyone = listParticipants(ctx).participants;
  // A bare roll is a roll, not a card: it goes to the roll lookup (and can prefill a walk-in).
  const qr = KMIT_ROLL_RE.test(normaliseRoll(q)) ? null : parseIdQr(q);
  if (qr) {
    const res = resolveIdQr(qr, everyone);
    const suffix = rollKey(qr.suffix);
    const matches = qr.roll ? everyone.filter((p) => rollKey(p.roll) === rollKey(qr.roll ?? '')) : everyone.filter((p) => rollSuffix(p.roll) === suffix);
    return {
      read: 'qr',
      qr: { suffix: qr.suffix, surname: qr.surname, batch: qr.batch, section: qr.section, branch: qr.branch },
      pickId: res.kind === 'one' ? res.who.id : null,
      matches,
    };
  }
  const key = rollKey(q);
  let exact = everyone.filter((p) => rollKey(p.roll) === key);
  if (exact.length === 0) exact = everyone.filter((p) => typedRollMatches(q, p.roll));
  if (exact.length) return { read: 'roll', qr: null, pickId: exact.length === 1 ? (exact[0]?.id ?? null) : null, matches: exact };
  const needle = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const matches = everyone
    .filter((p) => (key.length >= 3 && rollKey(p.roll).includes(key)) || p.name.toLowerCase().includes(needle) || (p.attendee?.nickname ?? '').toLowerCase().includes(needle))
    .slice(0, 30);
  return { read: 'search', qr: null, pickId: matches.length === 1 ? (matches[0]?.id ?? null) : null, matches };
}

/* ---------------------------------------------------------------- gate */

function toGatePerson(r: ParticipantRow): GatePerson {
  const last4 = phoneLast4(r.phone);
  return {
    id: r.id,
    roll: r.roll,
    name: r.name,
    year: r.year,
    section: r.section,
    phoneLast4: last4.length === 4 ? last4 : null,
    note: r.note,
    signedIn: r.attendee !== null,
    gateEnteredAt: r.gateEnteredAt,
  };
}

export function gateCount(ctx: AppContext): GateCount {
  const row = one<{ total: number; entered: number }>(ctx.db, 'SELECT COUNT(*) AS total, COUNT(gate_entered_at) AS entered FROM participants');
  return { total: row?.total ?? 0, entered: row?.entered ?? 0 };
}

export function gateStats(ctx: AppContext): GateStats {
  const { total, entered } = gateCount(ctx);
  const recent: GateRecent[] = all<{ id: number; name: string; roll: string; year: string | null; section: string | null; gate_entered_at: number }>(
    ctx.db,
    'SELECT id, name, roll, year, section, gate_entered_at FROM participants WHERE gate_entered_at IS NOT NULL ORDER BY gate_entered_at DESC, id DESC LIMIT 12',
  ).map((r) => ({ id: r.id, name: r.name, roll: r.roll, year: r.year, section: r.section, gateEnteredAt: r.gate_entered_at }));
  return { total, entered, recent };
}

/** Door check: scan an ID card QR or type a roll / name. Returns privacy-trimmed matches and live counts. */
export function gateLookup(ctx: AppContext, q: string): GateLookupResponse {
  const r = deskLookup(ctx, q);
  return {
    read: r.read,
    qrSuffix: r.qr?.suffix ?? null,
    matches: r.matches.map(toGatePerson),
    stats: gateCount(ctx),
  };
}

/** Mark a registered participant as let in at the door. Atomic: a second tap reports newlyEntered = false. */
export function markGateEntered(ctx: AppContext, id: number): GateEnterResponse {
  const now = ctx.now();
  const newlyEntered = tx(ctx.db, () => {
    const exists = one<{ id: number }>(ctx.db, 'SELECT id FROM participants WHERE id = ?', id);
    if (!exists) throw notFound('No such participant.');
    return run(ctx.db, 'UPDATE participants SET gate_entered_at = ? WHERE id = ? AND gate_entered_at IS NULL', now, id).changes === 1;
  });
  const person = toGatePerson(getParticipant(ctx, id));
  const stats = gateCount(ctx);
  if (newlyEntered) {
    ctx.live.publish('gate.changed', { entered: stats.entered, total: stats.total, participantId: id, enteredAt: person.gateEnteredAt }, ['gates', 'admins']);
  }
  return { person, newlyEntered, stats };
}

/** Clear a participant's door-entry timestamp (in case a coordinator tapped by mistake). */
export function undoGateEntered(ctx: AppContext, id: number): GateUndoResponse {
  const cur = one<{ gate_entered_at: number | null }>(ctx.db, 'SELECT gate_entered_at FROM participants WHERE id = ?', id);
  if (!cur) throw notFound('No such participant.');
  const had = cur.gate_entered_at !== null;
  if (had) run(ctx.db, 'UPDATE participants SET gate_entered_at = NULL WHERE id = ?', id);
  const person = toGatePerson(getParticipant(ctx, id));
  const stats = gateCount(ctx);
  if (had) {
    ctx.live.publish('gate.changed', { entered: stats.entered, total: stats.total, participantId: id, enteredAt: null }, ['gates', 'admins']);
  }
  return { person, stats };
}
