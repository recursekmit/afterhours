import type { FastifyRequest } from 'fastify';
import { HttpError, unauthorized } from '../errors';
import type { Viewer } from '../live/bus';
import { one } from '../db';
import { COOKIES, findSession } from './sessions';

export interface AttendeeAuth {
  attendeeId: number;
  kitId: string;
  profileComplete: boolean;
}

const attendeeMemo = new WeakMap<FastifyRequest, AttendeeAuth | null>();

/** The signed-in attendee for this request, or null. Never throws. */
export function getAttendee(req: FastifyRequest): AttendeeAuth | null {
  if (attendeeMemo.has(req)) return attendeeMemo.get(req) ?? null;
  const ctx = req.server.ctx;
  const s = findSession(ctx, 'attendee', req.cookies[COOKIES.attendee]);
  let auth: AttendeeAuth | null = null;
  if (s?.attendeeId != null) {
    const row = one<{ kit_id: string; profile_complete: number }>(
      ctx.db,
      'SELECT kit_id, profile_complete FROM attendees WHERE id = ?',
      s.attendeeId,
    );
    if (row) auth = { attendeeId: s.attendeeId, kitId: row.kit_id, profileComplete: row.profile_complete === 1 };
  }
  attendeeMemo.set(req, auth);
  return auth;
}

/**
 * Use at the top of an attendee route:
 *   const me = requireAttendee(req);
 * Throws 401 if not signed in, 403 profile_required if they have not finished
 * the first-sign-in profile (pass allowIncompleteProfile to skip that check).
 */
export function requireAttendee(req: FastifyRequest, opts: { allowIncompleteProfile?: boolean } = {}): AttendeeAuth {
  const a = getAttendee(req);
  if (!a) throw unauthorized('Sign in with your kit first.');
  if (!a.profileComplete && !opts.allowIncompleteProfile) {
    throw new HttpError(403, 'profile_required', 'Finish your profile first.');
  }
  return a;
}

export function isAdmin(req: FastifyRequest): boolean {
  return findSession(req.server.ctx, 'admin', req.cookies[COOKIES.admin]) !== null;
}

/** Console-only routes. */
export function requireAdmin(req: FastifyRequest): void {
  if (!isAdmin(req)) throw unauthorized('Console PIN needed.');
}

/** Projector routes. An admin session also passes, so the console can preview scenes. */
export function isScreen(req: FastifyRequest): boolean {
  return findSession(req.server.ctx, 'screen', req.cookies[COOKIES.screen]) !== null || isAdmin(req);
}

export function requireScreen(req: FastifyRequest): void {
  if (!isScreen(req)) throw unauthorized('Projector PIN needed.');
}

/** Door / gate coordinator routes. An admin session also passes. */
export function isGate(req: FastifyRequest): boolean {
  return findSession(req.server.ctx, 'gate', req.cookies[COOKIES.gate]) !== null || isAdmin(req);
}

export function requireGate(req: FastifyRequest): void {
  if (!isGate(req)) throw unauthorized('Gate PIN needed.');
}

/** Who this request is, for live-event audience matching. */
export function viewerOf(req: FastifyRequest): Viewer {
  const a = getAttendee(req);
  const admin = isAdmin(req);
  const screen = findSession(req.server.ctx, 'screen', req.cookies[COOKIES.screen]) !== null;
  const gate = findSession(req.server.ctx, 'gate', req.cookies[COOKIES.gate]) !== null;
  return { attendeeId: a?.attendeeId ?? null, admin, screen, gate };
}
