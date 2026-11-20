// "the morse slip": the Morse challenge every participant takes home in their kit. FOUR unique tickets,
// slips I-IV x 80 copies. A serial is one participant's set: serial 037 is slips I-IV no. 037, printed
// together on one A4 page (SLIP_SIZES.quad, four per page), each in a different ticket design; slip I's
// design is that participant's guild (20 of each design over the 80). Every edge of every copy has its
// own words. No venue locations needed.
//
// It is a graph trail with ONE slip stop (slip I) that is also the finale. The stop reads all four tickets
// of the set (engine.submitSlip), and the first scan of any ticket reserves the whole serial (unique.ts).
// Simple mode (before the cipher feature uses slips I-IV for its trials):
//   slip I:     bottom finishes the challenge (points, finish stamp, rank and speed bonuses); left a bonus;
//               right a clue; top a decoy, and so is that strip read upside down;
//   slips II-IV: each edge a small bonus or a clue, and one decoy each.
// Created by the seed and, on the live database, by POST /api/hunt/admin/morse-slip (the console button);
// an older one-ticket set is rebuilt into four by POST /api/hunt/admin/morse-slip/rebuild while nothing is
// claimed. Neither touches another trail or a visibility switch.
import type { MorseSlipSetup } from '@afterhours/shared/features/hunt';
import { type FeatureContext, conflict, notFound, one, run, tx } from '../../core';
import { newCode, newSeed, newToken } from './engine';
import { syncCopies } from './unique';

export const MORSE_SLIP_TITLE = 'the morse slip';
export const MORSE_SLIP_COPIES = 80;
export const MORSE_SLIP_POINTS = 25;
export const MORSE_SLIP_BONUS = 10;
export const MORSE_SLIP_SMALL_BONUS = 5;
/** The print size of the morse tickets: four per A4 page. */
export const MORSE_SLIP_PRINT_SIZE = 'quad';
export const ROMAN = ['I', 'II', 'III', 'IV'] as const;

export const MORSE_SLIP_CLUE =
  'Your kit has four Morse tickets, I to IV, and their words are yours alone. Scan any edge of any ticket, or decode it with the chart and type the word. Tickets II, III and IV hide bonuses and clues; ticket I’s bottom edge (art the right way up) finishes the challenge, so collect the rest first.';

type R = { orientation: 'bottom' | 'right' | 'top' | 'left' | 'extra'; outcome: 'next' | 'clue' | 'bonus' | 'decoy'; clue?: string; bonus?: number; message: string };

/** What every edge of slips I-IV does (the same on every copy; only the words differ). */
export const MORSE_TICKET_READINGS: R[][] = [
  [
    { orientation: 'bottom', outcome: 'next', message: 'That is the word. Morse challenge complete.' },
    { orientation: 'left', outcome: 'bonus', bonus: MORSE_SLIP_BONUS, message: `A hidden bonus on ticket I: +${MORSE_SLIP_BONUS}.` },
    { orientation: 'right', outcome: 'clue', clue: 'Good ear. Tickets II, III and IV each hide bonuses and a clue. Collect them, then come back to ticket I: its bottom edge ends it.', message: 'a clue, written along that edge.' },
    { orientation: 'top', outcome: 'decoy', message: 'Upside-down art, upside-down luck: that edge is a decoy. Turn it back.' },
    { orientation: 'extra', outcome: 'decoy', message: 'You read the top strip upside down. Clever, but no.' },
  ],
  [
    { orientation: 'bottom', outcome: 'bonus', bonus: MORSE_SLIP_SMALL_BONUS, message: `Ticket II pays: +${MORSE_SLIP_SMALL_BONUS}.` },
    { orientation: 'left', outcome: 'bonus', bonus: MORSE_SLIP_SMALL_BONUS, message: `Another edge, another +${MORSE_SLIP_SMALL_BONUS}.` },
    { orientation: 'right', outcome: 'clue', clue: 'Samuel Morse was a painter first. The code came after a letter about his wife arrived too late.', message: 'a clue on ticket II.' },
    { orientation: 'top', outcome: 'decoy', message: 'A decoy. No harm done, turn it again.' },
  ],
  [
    { orientation: 'bottom', outcome: 'clue', clue: 'E is a single dot because it is the most common letter in English. Morse counted the type in a printer’s case.', message: 'a clue on ticket III.' },
    { orientation: 'right', outcome: 'bonus', bonus: MORSE_SLIP_SMALL_BONUS, message: `Ticket III pays: +${MORSE_SLIP_SMALL_BONUS}.` },
    { orientation: 'left', outcome: 'bonus', bonus: MORSE_SLIP_SMALL_BONUS, message: `Nice turn: +${MORSE_SLIP_SMALL_BONUS}.` },
    { orientation: 'top', outcome: 'decoy', message: 'That one is a decoy. Keep turning.' },
  ],
  [
    { orientation: 'bottom', outcome: 'bonus', bonus: MORSE_SLIP_SMALL_BONUS, message: `Ticket IV pays: +${MORSE_SLIP_SMALL_BONUS}.` },
    { orientation: 'right', outcome: 'bonus', bonus: MORSE_SLIP_SMALL_BONUS, message: `One more: +${MORSE_SLIP_SMALL_BONUS}.` },
    { orientation: 'left', outcome: 'clue', clue: 'SOS was picked because it is easy to send and hard to miss: three dots, three dashes, three dots, no gaps.', message: 'a clue on ticket IV.' },
    { orientation: 'top', outcome: 'decoy', message: 'Decoy! The art is upside down, so is the luck.' },
  ],
];

export function findMorseSlip(ctx: FeatureContext): MorseSlipSetup | null {
  const t = one<{ id: number }>(ctx.db, "SELECT id FROM hunt_trails WHERE kind = 'morse' AND title = ? ORDER BY id LIMIT 1", MORSE_SLIP_TITLE);
  if (!t) return null;
  const set = one<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slip_sets WHERE trail_id = ? ORDER BY id LIMIT 1', t.id);
  return set ? { trailId: t.id, setId: set.id, created: false } : null;
}

/**
 * The set id of the morse ticket set: the unique slip set of the kind 'morse' trail titled "the morse slip"
 * (slips I-IV x 80 copies; a serial is one participant's four tickets), or null when it has not been
 * created yet. For other features (cipher) that read ticket copies and claims through ./unique.
 */
export function getMorseTicketSet(ctx: FeatureContext): number | null {
  return findMorseSlip(ctx)?.setId ?? null;
}

/** Slips I-IV with their readings, the stop pointed at slip I, then every copy's words and design. */
function buildTickets(ctx: FeatureContext, trailId: number, setId: number, copies: number): void {
  const ids: number[] = [];
  MORSE_TICKET_READINGS.forEach((readings, i) => {
    const slipId = run(ctx.db, 'INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, ?, ?)', setId, i + 1, `ticket ${ROMAN[i]}`).lastId;
    ids.push(slipId);
    for (const r of readings) {
      run(
        ctx.db,
        'INSERT INTO hunt_slip_readings (slip_id, orientation, word, morse, outcome, target_stop_id, target_trail_id, clue, bonus_points, message) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?)',
        slipId,
        r.orientation,
        r.outcome,
        r.clue ?? '',
        r.bonus ?? 0,
        r.message,
      );
    }
  });
  run(ctx.db, "UPDATE hunt_stops SET slip_id = ?, clue = ?, title = 'your morse tickets' WHERE trail_id = ? AND challenge = 'slip'", ids[0] as number, MORSE_SLIP_CLUE, trailId);
  run(ctx.db, 'UPDATE hunt_slip_sets SET copies = ?, print_size = ? WHERE id = ?', copies, MORSE_SLIP_PRINT_SIZE, setId);
  syncCopies(ctx, setId, { copies });
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
    run(
      ctx.db,
      `INSERT INTO hunt_stops (trail_id, position, title, clue, clue_image, challenge, require_scan, online_fallback, slip_id, next_stop_id, is_finale,
                               answers, hints, points, glyph, color, reveal, location, token, code)
       VALUES (?, 1, 'your morse tickets', ?, NULL, 'slip', 0, 0, NULL, NULL, 1, '[]', '[]', ?, 'wave', 'sky', ?, 'in your kit', ?, ?)`,
      trailId,
      MORSE_SLIP_CLUE,
      MORSE_SLIP_POINTS,
      'Samuel Morse sent the first long-distance telegram in 1844. You just read four of them off your tickets.',
      newToken(),
      newCode(ctx),
    );
    buildTickets(ctx, trailId, setId, copies);
    return { trailId, setId, created: true };
  });
}

/**
 * The live-database switch to four tickets: rebuild the morse slip's set into slips I-IV x `copies`, with
 * new words and designs for every copy (print after this, not before). Refused once anything is claimed or
 * found, so nothing anyone holds is ever invalidated. Other trails and both switches are untouched.
 */
export function rebuildMorseTickets(ctx: FeatureContext, copies = MORSE_SLIP_COPIES): MorseSlipSetup {
  const have = findMorseSlip(ctx);
  if (!have) throw notFound('There is no morse slip yet. Create it first.');
  const claimed = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copies c JOIN hunt_slips s ON s.id = c.slip_id WHERE s.set_id = ? AND c.claimed_by IS NOT NULL', have.setId)?.n ?? 0;
  const found = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_finds f JOIN hunt_slip_readings r ON r.id = f.reading_id JOIN hunt_slips s ON s.id = r.slip_id WHERE s.set_id = ?', have.setId)?.n ?? 0;
  if (claimed > 0 || found > 0) throw conflict(`People already scanned these tickets (${claimed} claimed). Release them all (or reset the trail) before rebuilding.`);
  return tx(ctx.db, () => {
    run(ctx.db, "UPDATE hunt_stops SET slip_id = NULL WHERE trail_id = ? AND challenge = 'slip'", have.trailId);
    run(ctx.db, 'DELETE FROM hunt_slips WHERE set_id = ?', have.setId); // readings, copies and words cascade
    run(ctx.db, "UPDATE hunt_slip_sets SET mode = 'unique' WHERE id = ?", have.setId);
    buildTickets(ctx, have.trailId, have.setId, copies);
    return { ...have, created: false };
  });
}
