// Test fixtures for the cipher tests (not used at runtime): the standalone Morse ticket set as hunt will
// create it (a kind 'morse' trail "the morse slip", slips I-IV, unique copies, four generated edges on
// every slip, and slip I's top strip upside down), and taps for a word.
import type { Press } from '@afterhours/shared/features/morse';
import { wordToPatterns } from '@afterhours/shared/features/morse';
import { type FeatureContext, all, run } from '../../core';
import { syncCopies } from '../hunt/unique';
import { MORSE_TICKET_TRAIL_TITLE } from './adapter';

export function makeTicketSet(ctx: FeatureContext, copies = 12): { setId: number; slips: number[]; trailId: number } {
  const trailId = run(ctx.db, "INSERT INTO hunt_trails (position, kind, title, status, order_mode, shuffle_seed) VALUES (9, 'morse', ?, 'open', 'graph', 'seed')", MORSE_TICKET_TRAIL_TITLE).lastId;
  const setId = run(ctx.db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool, copies) VALUES (?, 'the morse slips', 'unique', '[]', ?)", trailId, copies).lastId;
  const slips: number[] = [];
  for (let n = 1; n <= 4; n++) {
    const slipId = run(ctx.db, 'INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, ?, ?)', setId, n, `slip ${n}`).lastId;
    for (const o of ['bottom', 'right', 'top', 'left', ...(n === 1 ? ['extra'] : [])]) run(ctx.db, "INSERT INTO hunt_slip_readings (slip_id, orientation, outcome, message) VALUES (?, ?, 'clue', '')", slipId, o);
    slips.push(slipId);
  }
  syncCopies(ctx, setId);
  return { setId, slips, trailId };
}

export type Words = Record<'bottom' | 'right' | 'top' | 'left', string>;

/** Every copy's edge words: words.get(serial)[slipNo - 1].bottom ... */
export function copyWords(ctx: FeatureContext, slips: number[]): Map<number, Words[]> {
  const out = new Map<number, Words[]>();
  slips.forEach((slipId, i) => {
    const rows = all<{ serial: number; orientation: string; word: string | null }>(
      ctx.db,
      `SELECT c.serial, r.orientation, w.word FROM hunt_slip_copies c JOIN hunt_slip_copy_words w ON w.copy_id = c.id JOIN hunt_slip_readings r ON r.id = w.reading_id
        WHERE c.slip_id = ? AND r.orientation != 'extra'`,
      slipId,
    );
    for (const r of rows) {
      const m = out.get(r.serial) ?? [{}, {}, {}, {}].map(() => ({}) as Words);
      if (r.word) (m[i] as Record<string, string>)[r.orientation] = r.word;
      out.set(r.serial, m);
    }
  });
  return out;
}

/** Human-ish taps for a word at unit `u` ms, with +-jitter (0..1) on every press and gap, seeded. */
export function tapsFor(word: string, u = 120, jitter = 0, seed = 1): Press[] {
  let x = seed;
  const rnd = () => {
    x = (x * 16807) % 2147483647;
    return (x / 2147483647) * 2 - 1;
  };
  const j = (v: number) => Math.max(15, Math.round(v * (1 + jitter * rnd())));
  const out: Press[] = [];
  let t = 0;
  wordToPatterns(word).forEach((p, li) => {
    if (li > 0) t += j(3 * u);
    [...p].forEach((el, ei) => {
      if (ei > 0) t += j(u);
      const d = j(el === '.' ? u : 3 * u);
      out.push([t, t + d]);
      t += d;
    });
  });
  return out;
}
