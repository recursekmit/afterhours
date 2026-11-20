// Unique slips (docs/SLIPS.md, "unique slips"): N printed copies of every slip in a set, each copy with
// its own words on every edge, claimed by the first person whose reading matches it.
//
// The readings (hunt_slip_readings) still say what each ORIENTATION does, once, for every copy. Only
// the words differ: hunt_slip_copy_words holds the word a copy carries for each generated reading.
// A reading is "generated" when it is an edge with no fixed word or sequence; an 'extra' with no
// sequence is "derived": that copy's top strip read upside down.
import { randomBytes } from 'node:crypto';
import { type SlipCopies, slipWordKey } from '@afterhours/shared/features/hunt';
import { type SlipEdge, reverseReading } from '@afterhours/shared/morse-slip';
import { type FeatureContext, all, badRequest, conflict, notFound, one, run, tx } from '../../core';
import { type WordSlot, generateWords } from './slipwords';

interface SetRow {
  id: number;
  trail_id: number;
  title: string;
  mode: 'shared' | 'per_kit' | 'unique';
  copies: number;
}
interface ReadingRow {
  id: number;
  slip_id: number;
  orientation: 'bottom' | 'right' | 'top' | 'left' | 'extra';
  word: string | null;
  morse: string | null;
  message: string;
  clue: string;
}
const EDGES = new Set(['bottom', 'right', 'top', 'left']);

export const isGenerated = (r: { orientation: string; word: string | null; morse: string | null }): boolean => EDGES.has(r.orientation) && r.word === null && r.morse === null;
export const isDerived = (r: { orientation: string; word: string | null; morse: string | null }): boolean => r.orientation === 'extra' && r.word === null && r.morse === null;

export function getSet(ctx: FeatureContext, setId: number): SetRow {
  const s = one<SetRow>(ctx.db, 'SELECT id, trail_id, title, mode, copies FROM hunt_slip_sets WHERE id = ?', setId);
  if (!s) throw notFound('No such slip set.');
  return s;
}

export function setOfSlip(ctx: FeatureContext, slipId: number): SetRow | undefined {
  return one<SetRow>(ctx.db, 'SELECT ss.id, ss.trail_id, ss.title, ss.mode, ss.copies FROM hunt_slips s JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE s.id = ?', slipId);
}

/** An 'extra' with no sequence on a unique slip means "the top strip upside down": it needs a generated top edge. */
export function checkUniqueReadings(readings: readonly { orientation: string; word: string | null; morse: string | null }[]): void {
  if (readings.some(isDerived) && !readings.some((r) => r.orientation === 'top' && isGenerated(r))) {
    throw badRequest('An empty extra on a unique slip is "the top strip read upside down", so the slip needs a top edge without a fixed word.');
  }
}

/**
 * Bring a unique set's copies in line: serials 1..N for every slip, a word on every copy for every
 * generated reading, and the derived upside-down extras. Words already printed are never changed,
 * except with `regenerate` (only while nothing is claimed). Shrinking never drops a claimed copy.
 */
export function syncCopies(ctx: FeatureContext, setId: number, opts: { copies?: number; regenerate?: boolean } = {}): void {
  const set = getSet(ctx, setId);
  if (set.mode !== 'unique') throw conflict('That set does not print unique copies.');
  const n = opts.copies ?? set.copies;
  tx(ctx.db, () => {
    const claimed = (where: string, ...args: number[]) =>
      one<{ serial: number; slip_no: number }>(
        ctx.db,
        `SELECT c.serial, s.slip_no FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id WHERE s.set_id = ? AND c.claimed_by IS NOT NULL ${where} LIMIT 1`,
        setId,
        ...args,
      );
    if (opts.regenerate) {
      if (claimed('')) throw conflict('Someone already claimed a copy of this set. Release every copy before drawing new words (and reprint everything).');
      run(ctx.db, 'DELETE FROM hunt_slip_copy_words WHERE copy_id IN (SELECT c.id FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id WHERE s.set_id = ?)', setId);
    }
    const over = claimed('AND c.serial > ?', n);
    if (over) throw conflict(`Copy no. ${String(over.serial).padStart(3, '0')} of slip ${over.slip_no} is claimed. Release it before printing fewer copies.`);
    run(ctx.db, 'DELETE FROM hunt_slip_copies WHERE serial > ? AND slip_id IN (SELECT id FROM hunt_slips WHERE set_id = ?)', n, setId);
    run(ctx.db, 'UPDATE hunt_slip_sets SET copies = ? WHERE id = ?', n, setId);

    const slips = all<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slips WHERE set_id = ? ORDER BY slip_no, id', setId);
    const slots: (WordSlot & { copyId: number; readingId: number })[] = [];
    for (const sl of slips) {
      for (let serial = 1; serial <= n; serial++) run(ctx.db, 'INSERT OR IGNORE INTO hunt_slip_copies (slip_id, serial) VALUES (?, ?)', sl.id, serial);
      const readings = all<ReadingRow>(ctx.db, 'SELECT * FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id', sl.id);
      const generated = readings.filter(isGenerated);
      // words of readings that are no longer generated (a fixed word was typed in), and every derived extra (rebuilt below)
      const keep = generated.map((r) => r.id);
      run(
        ctx.db,
        `DELETE FROM hunt_slip_copy_words WHERE copy_id IN (SELECT id FROM hunt_slip_copies WHERE slip_id = ?)${keep.length ? ` AND reading_id NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
        sl.id,
        ...keep,
      );
      const have = new Set(
        all<{ copy_id: number; reading_id: number }>(ctx.db, 'SELECT w.copy_id, w.reading_id FROM hunt_slip_copy_words w JOIN hunt_slip_copies c ON c.id = w.copy_id WHERE c.slip_id = ?', sl.id).map(
          (r) => `${r.copy_id}:${r.reading_id}`,
        ),
      );
      const copies = all<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slip_copies WHERE slip_id = ? ORDER BY serial', sl.id);
      for (const c of copies) for (const r of generated) if (!have.has(`${c.id}:${r.id}`)) slots.push({ edge: r.orientation as SlipEdge, group: sl.id, copyId: c.id, readingId: r.id });
    }
    if (slots.length > 0) {
      const taken = all<{ morse: string }>(ctx.db, 'SELECT morse FROM hunt_slip_copy_words').map((r) => r.morse);
      const near = all<{ slip_id: number; morse: string }>(ctx.db, 'SELECT c.slip_id, w.morse FROM hunt_slip_copy_words w JOIN hunt_slip_copies c ON c.id = w.copy_id WHERE w.word IS NOT NULL').map(
        (r) => [r.slip_id, r.morse] as const,
      );
      let words: string[];
      try {
        words = generateWords(slots, { seed: randomBytes(8).toString('hex'), taken, near });
      } catch (e) {
        throw conflict((e as Error).message);
      }
      slots.forEach((s, i) => {
        const w = words[i] as string;
        run(ctx.db, 'INSERT INTO hunt_slip_copy_words (copy_id, reading_id, word, morse) VALUES (?, ?, ?, ?)', s.copyId, s.readingId, w, slipWordKey(w));
      });
    }
    // derived extras: each copy's top strip, upside down
    for (const sl of slips) {
      const readings = all<ReadingRow>(ctx.db, 'SELECT * FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id', sl.id);
      const top = readings.find((r) => r.orientation === 'top' && isGenerated(r));
      const derived = readings.filter(isDerived);
      if (!top || derived.length === 0) continue;
      const tops = all<{ copy_id: number; morse: string }>(
        ctx.db,
        'SELECT w.copy_id, w.morse FROM hunt_slip_copy_words w JOIN hunt_slip_copies c ON c.id = w.copy_id WHERE c.slip_id = ? AND w.reading_id = ?',
        sl.id,
        top.id,
      );
      // one derived extra per slip is meaningful (the same sequence cannot do two things)
      const d = derived[0] as ReadingRow;
      for (const t of tops) run(ctx.db, 'INSERT OR IGNORE INTO hunt_slip_copy_words (copy_id, reading_id, word, morse) VALUES (?, ?, NULL, ?)', t.copy_id, d.id, reverseReading(t.morse));
    }
  });
}

export interface UniqueMatch {
  readingId: number;
  copyId: number;
  serial: number;
  claimedBy: number | null;
}

/** Which printed copy of this slip (if any) carries one of these Morse keys. */
export function matchCopy(ctx: FeatureContext, slipId: number, keys: Iterable<string>): UniqueMatch | null {
  for (const key of keys) {
    const r = one<{ reading_id: number; copy_id: number; serial: number; claimed_by: number | null }>(
      ctx.db,
      'SELECT w.reading_id, c.id AS copy_id, c.serial, c.claimed_by FROM hunt_slip_copy_words w JOIN hunt_slip_copies c ON c.id = w.copy_id WHERE w.morse = ? AND c.slip_id = ?',
      key,
      slipId,
    );
    if (r) return { readingId: r.reading_id, copyId: r.copy_id, serial: r.serial, claimedBy: r.claimed_by };
  }
  return null;
}

/** The serial of the copy of this slip an attendee holds, or null. */
export function myCopy(ctx: FeatureContext, attendeeId: number, slipId: number): number | null {
  return one<{ serial: number }>(ctx.db, 'SELECT serial FROM hunt_slip_copies WHERE slip_id = ? AND claimed_by = ?', slipId, attendeeId)?.serial ?? null;
}

export type ClaimResult = { kind: 'mine'; serial: number; fresh: boolean } | { kind: 'taken' } | { kind: 'other_copy'; serial: number };

/**
 * Claim a copy for an attendee, atomically: one conditional UPDATE in a transaction, backed by the
 * (slip, claimed_by) unique index, so two people racing for one copy give exactly one winner and one
 * person can never hold two copies of the same slip.
 */
export function claimCopy(ctx: FeatureContext, attendeeId: number, copyId: number): ClaimResult {
  return tx(ctx.db, (): ClaimResult => {
    const c = one<{ slip_id: number; serial: number; claimed_by: number | null }>(ctx.db, 'SELECT slip_id, serial, claimed_by FROM hunt_slip_copies WHERE id = ?', copyId);
    if (!c) return { kind: 'taken' };
    if (c.claimed_by === attendeeId) return { kind: 'mine', serial: c.serial, fresh: false };
    if (c.claimed_by !== null) return { kind: 'taken' };
    const held = myCopy(ctx, attendeeId, c.slip_id);
    if (held !== null) return { kind: 'other_copy', serial: held };
    try {
      const r = run(ctx.db, 'UPDATE hunt_slip_copies SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL', attendeeId, ctx.now(), copyId);
      return r.changes === 1 ? { kind: 'mine', serial: c.serial, fresh: true } : { kind: 'taken' };
    } catch {
      // the unique index refused a second copy for this person
      const again = myCopy(ctx, attendeeId, c.slip_id);
      return again !== null ? { kind: 'other_copy', serial: again } : { kind: 'taken' };
    }
  });
}

/** A lost slip or a mistake: the copy is free again (its words do not change). */
export function releaseCopy(ctx: FeatureContext, copyId: number): number {
  const c = one<{ set_id: number }>(ctx.db, 'SELECT s.set_id FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id WHERE c.id = ?', copyId);
  if (!c) throw notFound('No such copy.');
  run(ctx.db, 'UPDATE hunt_slip_copies SET claimed_by = NULL, claimed_at = NULL WHERE id = ?', copyId);
  return c.set_id;
}

/** Trail reset: every copy of the trail's unique sets is free again. */
export function releaseTrail(ctx: FeatureContext, trailId: number): void {
  run(
    ctx.db,
    'UPDATE hunt_slip_copies SET claimed_by = NULL, claimed_at = NULL WHERE slip_id IN (SELECT s.id FROM hunt_slips s JOIN hunt_slip_sets ss ON ss.id = s.set_id WHERE ss.trail_id = ?)',
    trailId,
  );
}

export function claimedCount(ctx: FeatureContext, setId: number): number {
  return one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id WHERE s.set_id = ? AND c.claimed_by IS NOT NULL', setId)?.n ?? 0;
}

export function copiesView(ctx: FeatureContext, setId: number): SlipCopies {
  const set = getSet(ctx, setId);
  const slips = all<{ id: number; slip_no: number; label: string }>(ctx.db, 'SELECT id, slip_no, label FROM hunt_slips WHERE set_id = ? ORDER BY slip_no, id', setId);
  const cells = all<{ id: number; slip_id: number; serial: number; claimed_by: number | null; claimed_at: number | null; nickname: string | null }>(
    ctx.db,
    `SELECT c.id, c.slip_id, c.serial, c.claimed_by, c.claimed_at, a.nickname FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id
       LEFT JOIN attendees a ON a.id = c.claimed_by WHERE s.set_id = ? ORDER BY c.serial, s.slip_no, s.id`,
    setId,
  );
  const rows = new Map<number, SlipCopies['rows'][number]>();
  for (const c of cells) {
    let row = rows.get(c.serial);
    if (!row) rows.set(c.serial, (row = { serial: c.serial, cells: [] }));
    row.cells.push({ slipId: c.slip_id, copyId: c.id, claimedBy: c.claimed_by === null ? null : { attendeeId: c.claimed_by, nickname: c.nickname }, claimedAt: c.claimed_at });
  }
  return {
    setId,
    title: set.title,
    copies: set.copies,
    slips: slips.map((s) => ({ id: s.id, slipNo: s.slip_no, label: s.label })),
    rows: [...rows.values()],
    claimed: cells.filter((c) => c.claimed_by !== null).length,
    signedIn: one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM attendees WHERE first_signin_at IS NOT NULL')?.n ?? 0,
  };
}

/** Words a copy prints per edge (generated, or the reading's fixed word), plus its upside-down top. */
export function copyEdges(ctx: FeatureContext, copyId: number, slipId: number): { edges: Partial<Record<SlipEdge, string>>; upside: string | null } {
  const rows = all<{ orientation: string; fixed: string | null; word: string | null; morse: string | null }>(
    ctx.db,
    `SELECT r.orientation, r.word AS fixed, w.word, w.morse FROM hunt_slip_readings r
       LEFT JOIN hunt_slip_copy_words w ON w.reading_id = r.id AND w.copy_id = ? WHERE r.slip_id = ? ORDER BY r.id`,
    copyId,
    slipId,
  );
  const edges: Partial<Record<SlipEdge, string>> = {};
  let upside: string | null = null;
  for (const r of rows) {
    if (r.orientation === 'extra') {
      if (r.word === null && r.morse) upside = r.morse;
      continue;
    }
    const word = r.fixed ?? r.word;
    if (word) edges[r.orientation as SlipEdge] = word;
  }
  return { edges, upside };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The organisers' private answer key: serial -> words, one line per copy. */
export function answerKeyCsv(ctx: FeatureContext, setId: number): string {
  getSet(ctx, setId);
  const copies = all<{ id: number; slip_id: number; serial: number; slip_no: number; label: string; nickname: string | null }>(
    ctx.db,
    `SELECT c.id, c.slip_id, c.serial, s.slip_no, s.label, a.nickname FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id
       LEFT JOIN attendees a ON a.id = c.claimed_by WHERE s.set_id = ? ORDER BY c.serial, s.slip_no, s.id`,
    setId,
  );
  const lines = ['serial,slip_no,label,bottom,right,top,left,top_upside_down_morse,claimed_by'];
  for (const c of copies) {
    const { edges, upside } = copyEdges(ctx, c.id, c.slip_id);
    lines.push(
      [String(c.serial).padStart(3, '0'), c.slip_no, c.label, edges.bottom ?? '', edges.right ?? '', edges.top ?? '', edges.left ?? '', upside ?? '', c.nickname ?? ''].map(csvCell).join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Seeded copy that names the old shared words ("The bottom edge says LAB...") would be wrong on unique
 * slips. Exact seeded texts get their unique wording; anything else just loses the word.
 */
const REWRITES: Record<string, string> = {
  'The bottom edge says LAB. Head to the computer lab path.': 'The bottom edge sends you down the lab path. Head to the computer lab.',
  'The left edge says STAGE. A different path: off to the stage.': 'The left edge is a different path: off to the main stage.',
  'Every slip has a word you would expect at a tech club. Look for it.': 'Every edge of every slip says something different, and your slips are yours alone. Turn them all.',
  'NOPE is literally a decoy. Turn it again.': 'That edge is a decoy. Turn it again.',
  'MEET: go to where the paths meet.': 'Go to where the paths meet.',
  'A hidden GIFT: +10 points.': 'A hidden gift: +10 points.',
  'BACK? No going back. Try another edge.': 'No going back. Try another edge.',
  'END: the finale is open.': 'The finale is open.',
  'A loop goes round and round. The finale word does too, in a way.': 'Round and round: the finale word is the name of a club that calls itself.',
  'BOOK: start at the library.': 'Start at the library.',
  'CHAI: start at the canteen.': 'Start at the canteen.',
  'CODE: start at the lab.': 'Start at the lab.',
  'Both paths meet here. Slip 3, any edge that reads as a word you know.': 'Both paths meet here. Scan slip 3 and find the edge that ends it.',
};

function rewrite(text: string, word: string | null): string {
  if (REWRITES[text]) return REWRITES[text];
  if (!word || !text) return text;
  return text
    .replace(new RegExp(`\\b${word}\\b[:?!.]?\\s*`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The live-database migration: a shared set nobody has scanned yet becomes unique, keeping every
 * outcome. Edge words are cleared (each copy gets its own), an extra that was the top word upside down
 * becomes the derived extra, messages that named the old words are reworded, then N copies are drawn.
 */
export function convertToUnique(ctx: FeatureContext, setId: number, copies: number): void {
  const set = getSet(ctx, setId);
  if (set.mode === 'unique') {
    syncCopies(ctx, setId, { copies });
    return;
  }
  if (set.mode !== 'shared') throw conflict('Only shared sets switch to unique copies.');
  const finds = one<{ n: number }>(
    ctx.db,
    'SELECT COUNT(*) AS n FROM hunt_slip_finds f JOIN hunt_slip_readings r ON r.id = f.reading_id JOIN hunt_slips s ON s.id = r.slip_id WHERE s.set_id = ?',
    setId,
  )?.n;
  if (finds) throw conflict('People already scanned these slips. Reset the trail first, then switch.');
  tx(ctx.db, () => {
    const slips = all<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slips WHERE set_id = ?', setId);
    for (const sl of slips) {
      const readings = all<ReadingRow>(ctx.db, 'SELECT * FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id', sl.id);
      const top = readings.find((r) => r.orientation === 'top' && r.word);
      const upsideOfTop = top?.word ? reverseReading(slipWordKey(top.word)) : null;
      for (const r of readings) {
        const isEdge = EDGES.has(r.orientation);
        const derive = r.orientation === 'extra' && r.morse !== null && upsideOfTop !== null && r.morse === upsideOfTop;
        const word = isEdge ? r.word : derive ? (top?.word ?? null) : null;
        run(
          ctx.db,
          'UPDATE hunt_slip_readings SET word = ?, morse = ?, message = ?, clue = ? WHERE id = ?',
          isEdge || derive ? null : r.word,
          isEdge || derive ? null : r.morse,
          rewrite(r.message, word),
          rewrite(r.clue, word),
          r.id,
        );
      }
    }
    // stop clues on this set's slips that named a word
    for (const st of all<{ id: number; clue: string }>(ctx.db, 'SELECT id, clue FROM hunt_stops WHERE slip_id IN (SELECT id FROM hunt_slips WHERE set_id = ?)', setId)) {
      const next = REWRITES[st.clue];
      if (next) run(ctx.db, 'UPDATE hunt_stops SET clue = ? WHERE id = ?', next, st.id);
    }
    run(ctx.db, "UPDATE hunt_slip_sets SET mode = 'unique', copies = ? WHERE id = ?", copies, setId);
    // same transaction: if the words cannot be drawn, the set stays exactly as it was
    syncCopies(ctx, setId, { copies });
  });
}
