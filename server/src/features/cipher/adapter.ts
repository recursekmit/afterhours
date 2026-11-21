// Everything cipher reads from the hunt feature, in one place: the morse ticket set (hunt/morseSlip.ts),
// the "show morse challenge to players" switch (hunt/visibility.ts) and the claims (hunt/unique.ts).
import { type Guild, designFor } from '@afterhours/shared/features/cipher';
import { SLIP_TICKETS } from '@afterhours/shared/morse-slip';
import { type FeatureContext, all, one, tx } from '../../core';
import { getMorseTicketSet } from '../hunt/morseSlip';
import { type SerialRelease, claimCopy, onSerialReleased, serialInSet } from '../hunt/unique';
import { notOpen, setVisibility, visibility } from '../hunt/visibility';

/** The slip set of the morse tickets (slips I-IV x 80, unique), or null before it is created. */
export const morseTicketSet = (ctx: FeatureContext): number | null => getMorseTicketSet(ctx);

/** The set's slips in order: [I, II, III, IV] (slip ids). */
export function morseTicketSlips(ctx: FeatureContext, setId: number): number[] {
  return all<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slips WHERE set_id = ? ORDER BY slip_no, id', setId).map((r) => r.id);
}

/** The copy id of slip `slipId`, serial `serial` (hunt's table, read only). */
export function copyIdOf(ctx: FeatureContext, slipId: number, serial: number): number | null {
  return one<{ id: number }>(ctx.db, 'SELECT id FROM hunt_slip_copies WHERE slip_id = ? AND serial = ?', slipId, serial)?.id ?? null;
}

/** Who holds a copy right now (hunt's table, read only), or null. */
export function copyHolder(ctx: FeatureContext, copyId: number): number | null {
  return one<{ claimed_by: number | null }>(ctx.db, 'SELECT claimed_by FROM hunt_slip_copies WHERE id = ?', copyId)?.claimed_by ?? null;
}

/** The serial an attendee holds on any slip of the set, or null. */
export function heldSerial(ctx: FeatureContext, attendeeId: number, slips: readonly number[]): number | null {
  return slips.length ? serialInSet(ctx, attendeeId, slips[0] as number) : null;
}

export type SerialClaim = { kind: 'mine'; serial: number; fresh: boolean } | { kind: 'taken' } | { kind: 'other_serial'; serial: number };

/**
 * Claim every slip of a serial for an attendee, through hunt's claimCopy (whose first claim reserves the
 * whole serial). One transaction: refused (nothing claimed) if any slip belongs to someone else or the
 * attendee holds another serial.
 */
export function claimSerial(ctx: FeatureContext, attendeeId: number, slips: readonly number[], serial: number): SerialClaim {
  try {
    return tx(ctx.db, (): SerialClaim => {
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
    if (e instanceof Refused) return e.result; // rolled back: nothing of this serial was claimed
    throw e;
  }
}
class Refused extends Error {
  constructor(readonly result: SerialClaim) {
    super('refused');
  }
}

/** The print design of a copy (hunt stores one per copy); slip I's is the guild. */
export function copyDesign(ctx: FeatureContext, copyId: number, serial: number, slipNo: number): Guild {
  const d = one<{ design: string | null }>(ctx.db, 'SELECT design FROM hunt_slip_copies WHERE id = ?', copyId)?.design;
  return d && (SLIP_TICKETS as readonly string[]).includes(d) ? (d as Guild) : designFor(serial, slipNo);
}

/** The "show morse challenge to players" switch. */
export const morseChallengeVisible = (ctx: FeatureContext): boolean => visibility(ctx).morse;
export const setMorseChallengeVisible = (ctx: FeatureContext, on: boolean): void => void setVisibility(ctx, { morse: on });
export { notOpen };

/** Hunt frees a whole serial (console "release"): calls `fn` in the same transaction. */
export const onSetReleased = (ctx: FeatureContext, fn: (e: SerialRelease) => void): void => onSerialReleased(ctx, (_c, e) => fn(e));
