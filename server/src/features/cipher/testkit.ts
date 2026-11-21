// Test fixtures for the cipher tests (not used at runtime): hunt's real morse ticket set, every copy's
// words, and taps for a word.
import type { Press } from '@afterhours/shared/features/morse';
import { wordToPatterns } from '@afterhours/shared/features/morse';
import { type FeatureContext, all } from '../../core';
import { createMorseSlip } from '../hunt/morseSlip';
import { setVisibility } from '../hunt/visibility';

/** The real morse ticket set (hunt's createMorseSlip: slips I-IV, unique, `copies` serials), shown to players. */
export function makeTicketSet(ctx: FeatureContext, copies = 12): { setId: number; slips: number[]; trailId: number } {
  const m = createMorseSlip(ctx, copies);
  setVisibility(ctx, { morse: true });
  const slips = all<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slips WHERE set_id = ? ORDER BY slip_no', m.setId).map((r) => r.id);
  return { setId: m.setId, slips, trailId: m.trailId };
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
