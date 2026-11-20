// "the morse slip": the Morse challenge every participant takes home in their kit. ONE unique slip
// (80 printed copies, each with its own words, in all four ticket designs), no venue locations needed.
// It is a graph trail with a single slip stop that is also the finale:
//   bottom: the main answer. Reading it stamps the stop and finishes the challenge (points, a finish
//           stamp, the finish-rank and speed bonuses);
//   left:   a one-time bonus;
//   right:  a clue that nudges people to keep turning;
//   top:    a playful decoy, and so is that strip read upside down.
// Created by the seed and, on the live database, by POST /api/hunt/admin/morse-slip (the console button).
// Idempotent; touches no other trail and neither visibility switch.
import type { MorseSlipSetup } from '@afterhours/shared/features/hunt';
import { type FeatureContext, one, run, tx } from '../../core';
import { newCode, newSeed, newToken } from './engine';
import { syncCopies } from './unique';

export const MORSE_SLIP_TITLE = 'the morse slip';
export const MORSE_SLIP_COPIES = 80;
export const MORSE_SLIP_POINTS = 25;
export const MORSE_SLIP_BONUS = 10;

export const MORSE_SLIP_CLUE =
  'Your kit has one Morse slip, and its words are yours alone. Hold it with the art the right way up and read the bottom edge: that word finishes the challenge. Turn it to find a bonus, a clue and a decoy. Scan it, or decode it with the chart and type the word.';

export function findMorseSlip(ctx: FeatureContext): MorseSlipSetup | null {
  const t = one<{ id: number }>(ctx.db, "SELECT id FROM hunt_trails WHERE kind = 'morse' AND title = ? ORDER BY id LIMIT 1", MORSE_SLIP_TITLE);
  if (!t) return null;
  const set = one<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slip_sets WHERE trail_id = ? ORDER BY id LIMIT 1', t.id);
  return set ? { trailId: t.id, setId: set.id, created: false } : null;
}

/**
 * The set id of the morse ticket set: the unique slip set of the kind 'morse' trail titled "the morse slip"
 * (80 printed tickets, one per kit), or null when it has not been created yet. For other features (cipher)
 * that read ticket copies and claims through ./unique.
 */
export function getMorseTicketSet(ctx: FeatureContext): number | null {
  return findMorseSlip(ctx)?.setId ?? null;
}

export function createMorseSlip(ctx: FeatureContext, copies = MORSE_SLIP_COPIES): MorseSlipSetup {
  const have = findMorseSlip(ctx);
  if (have) return have;
  return tx(ctx.db, () => {
    const now = ctx.now();
    const pos = (one<{ m: number | null }>(ctx.db, 'SELECT MAX(position) AS m FROM hunt_trails')?.m ?? 0) + 1;
    // open, so it plays the moment "show morse challenge to players" is switched on
    const trailId = run(
      ctx.db,
      "INSERT INTO hunt_trails (position, kind, title, status, order_mode, hints_on, cooldown_on, shuffle_seed, opened_at) VALUES (?, 'morse', ?, 'open', 'graph', 0, 1, ?, ?)",
      pos,
      MORSE_SLIP_TITLE,
      newSeed(),
      now,
    ).lastId;
    const setId = run(ctx.db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool, copies) VALUES (?, 'the morse slip', 'unique', '[]', ?)", trailId, copies).lastId;
    const slipId = run(ctx.db, "INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, 1, 'your morse slip')", setId).lastId;
    const reading = (orientation: string, outcome: string, extra: { clue?: string; bonus?: number; message: string }) =>
      run(
        ctx.db,
        'INSERT INTO hunt_slip_readings (slip_id, orientation, word, morse, outcome, target_stop_id, target_trail_id, clue, bonus_points, message) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?)',
        slipId,
        orientation,
        outcome,
        extra.clue ?? '',
        extra.bonus ?? 0,
        extra.message,
      );
    reading('bottom', 'next', { message: 'That is the word. Morse challenge complete.' });
    reading('left', 'bonus', { bonus: MORSE_SLIP_BONUS, message: `A hidden bonus on the side: +${MORSE_SLIP_BONUS}.` });
    reading('right', 'clue', { clue: 'Good ear. Every edge says something different. Keep turning: one edge finishes it, one pays a bonus.', message: 'a clue, written along that edge.' });
    reading('top', 'decoy', { message: 'Upside-down art, upside-down luck: that edge is a decoy. Turn it back.' });
    reading('extra', 'decoy', { message: 'You read the top strip upside down. Clever, but no.' });
    run(
      ctx.db,
      `INSERT INTO hunt_stops (trail_id, position, title, clue, clue_image, challenge, require_scan, online_fallback, slip_id, next_stop_id, is_finale,
                               answers, hints, points, glyph, color, reveal, location, token, code)
       VALUES (?, 1, 'your morse slip', ?, NULL, 'slip', 0, 0, ?, NULL, 1, '[]', '[]', ?, 'wave', 'sky', ?, 'in your kit', ?, ?)`,
      trailId,
      MORSE_SLIP_CLUE,
      slipId,
      MORSE_SLIP_POINTS,
      'Samuel Morse sent the first long-distance telegram in 1844. You just read one off a ticket.',
      newToken(),
      newCode(ctx),
    );
    syncCopies(ctx, setId);
    return { trailId, setId, created: true };
  });
}
