// Adapters to the hunt feature, which another engineer is changing in parallel. Everything cipher needs
// from hunt's tables or its unfinished exports goes through this file, so swapping to hunt's real
// exports is a one-file change. Every function marked TODO-swap has a local stand-in.
import { type Guild, designFor } from '@afterhours/shared/features/cipher';
import { SLIP_TICKETS } from '@afterhours/shared/morse-slip';
import { type FeatureContext, all, one, tx } from '../../core';
import { claimCopy, myCopy } from '../hunt/unique';

/** The title of the standalone Morse ticket trail (kind 'morse'): four slips, unique copies. */
export const MORSE_TICKET_TRAIL_TITLE = 'the morse slip';

/**
 * The slip set of the standalone Morse tickets (slips I-IV, unique mode, 80 copies), or null.
 *
 * TODO-swap: replace the body with hunt's `getMorseTicketSet(ctx)` once it lands:
 *   import { getMorseTicketSet } from '../hunt';
 *   return getMorseTicketSet(ctx);
 */
export function morseTicketSet(ctx: FeatureContext): number | null {
  const r = one<{ id: number }>(
    ctx.db,
    `SELECT ss.id FROM hunt_slip_sets ss JOIN hunt_trails t ON t.id = ss.trail_id
      WHERE t.kind = 'morse' AND lower(t.title) = ? AND ss.mode = 'unique' ORDER BY ss.id LIMIT 1`,
    MORSE_TICKET_TRAIL_TITLE,
  );
  return r?.id ?? null;
}

/** The set's slips in order: [I, II, III, IV] (slip ids). */
export function morseTicketSlips(ctx: FeatureContext, setId: number): number[] {
  return all<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slips WHERE set_id = ? ORDER BY slip_no, id', setId).map((r) => r.id);
}

/** The copy id of slip `slipId`, serial `serial`. */
export function copyIdOf(ctx: FeatureContext, slipId: number, serial: number): number | null {
  return one<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slip_copies WHERE slip_id = ? AND serial = ?', slipId, serial)?.id ?? null;
}

/** The serial an attendee holds on any slip of the set, or null. */
export function heldSerial(ctx: FeatureContext, attendeeId: number, slips: readonly number[]): number | null {
  for (const slipId of slips) {
    const s = myCopy(ctx, attendeeId, slipId);
    if (s !== null) return s;
  }
  return null;
}

export type SerialClaim = { kind: 'mine'; serial: number; fresh: boolean } | { kind: 'taken' } | { kind: 'other_serial'; serial: number };

/**
 * Reserve a whole serial (slips I-IV) for an attendee: refused if any slip of it belongs to someone else
 * or the attendee already holds another serial. Atomic (one transaction over hunt's own claimCopy, whose
 * conditional UPDATE and unique index settle races).
 *
 * TODO-swap: hunt will own "the first scan of any slip reserves the whole serial". Swap for its export
 * (e.g. `claimSerial(ctx, attendeeId, setId, serial)`) once it lands.
 */
export function claimSerial(ctx: FeatureContext, attendeeId: number, slips: readonly number[], serial: number): SerialClaim {
  try {
    return tx(ctx.db, (): SerialClaim => {
      const held = heldSerial(ctx, attendeeId, slips);
      if (held !== null && held !== serial) return { kind: 'other_serial', serial: held };
      let fresh = false;
      for (const slipId of slips) {
        const copyId = copyIdOf(ctx, slipId, serial);
        if (copyId === null) continue;
        const c = claimCopy(ctx, attendeeId, copyId);
        if (c.kind === 'taken') throw new Refused({ kind: 'taken' });
        if (c.kind === 'other_copy') throw new Refused({ kind: 'other_serial', serial: c.serial });
        fresh ||= c.fresh;
      }
      return { kind: 'mine', serial, fresh };
    });
  } catch (e) {
    if (e instanceof Refused) return e.result; // the transaction rolled back every slip it had claimed
    throw e;
  }
}
class Refused extends Error {
  constructor(readonly result: SerialClaim) {
    super('refused');
  }
}

/**
 * The print design of a copy (the guild, for slip I). Uses a design stored on the copy when hunt stores
 * one (a `design` column on hunt_slip_copies); otherwise the documented rotation (designFor).
 *
 * TODO-swap: read hunt's per-copy design export once it lands.
 */
export function copyDesign(ctx: FeatureContext, copyId: number, serial: number, slipNo: number): Guild {
  if (hasDesignColumn(ctx)) {
    const d = one<{ design: string | null }>(ctx.db, 'SELECT design FROM hunt_slip_copies WHERE id = ?', copyId)?.design;
    if (d && (SLIP_TICKETS as readonly string[]).includes(d)) return d as Guild;
  }
  return designFor(serial, slipNo);
}
const designCols = new WeakMap<FeatureContext, boolean>();
function hasDesignColumn(ctx: FeatureContext): boolean {
  let v = designCols.get(ctx);
  if (v === undefined) {
    v = all<{ name: string }>(ctx.db, 'PRAGMA table_info(hunt_slip_copies)').some((c) => c.name === 'design');
    designCols.set(ctx, v);
  }
  return v;
}

/**
 * The "show morse challenge to players" switch.
 *
 * TODO-swap: hunt will own this switch. Until it lands, cipher keeps its own flag (cipher_config.visible,
 * the console's "show to players" button, default on). Swap the body for hunt's reader, e.g.
 *   import { isMorseChallengeVisible } from '../hunt';
 *   return isMorseChallengeVisible(ctx);
 */
export function morseChallengeVisible(ctx: FeatureContext): boolean {
  return (one<{ visible: number }>(ctx.db, 'SELECT visible FROM cipher_config WHERE id = 1')?.visible ?? 1) === 1;
}
