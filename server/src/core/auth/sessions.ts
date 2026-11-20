import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { one, run } from '../db';
import { newToken, sha256 } from './crypto';

export type SessionKind = 'attendee' | 'admin' | 'screen' | 'gate';

/** Separate cookies so a laptop can hold a console and an attendee session at once. */
export const COOKIES = {
  attendee: 'ah_sid',
  admin: 'ah_admin',
  screen: 'ah_screen',
  gate: 'ah_gate',
  /** Long-lived random id of this browser; its hash is what a kit binds to. */
  device: 'ah_dev',
} as const;

export function createSession(ctx: AppContext, kind: SessionKind, attendeeId: number | null) {
  const token = newToken();
  const now = ctx.now();
  const expiresAt = now + ctx.config.sessionHours * 3600_000;
  run(
    ctx.db,
    'INSERT INTO sessions (token_hash, kind, attendee_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    kind,
    attendeeId,
    now,
    expiresAt,
  );
  return { token, expiresAt };
}

export function findSession(ctx: AppContext, kind: SessionKind, token: string | undefined) {
  if (!token || token.length > 100) return null;
  const row = one<{ attendee_id: number | null; expires_at: number }>(
    ctx.db,
    'SELECT attendee_id, expires_at FROM sessions WHERE token_hash = ? AND kind = ?',
    sha256(token),
    kind,
  );
  if (!row || row.expires_at < ctx.now()) return null;
  return { attendeeId: row.attendee_id, expiresAt: row.expires_at };
}

export function deleteSession(ctx: AppContext, token: string | undefined) {
  if (token) run(ctx.db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function revokeAttendeeSessions(ctx: AppContext, attendeeId: number) {
  return run(ctx.db, "DELETE FROM sessions WHERE kind = 'attendee' AND attendee_id = ?", attendeeId).changes;
}

export function purgeExpiredSessions(ctx: AppContext) {
  return run(ctx.db, 'DELETE FROM sessions WHERE expires_at < ?', ctx.now()).changes;
}

export function setCookie(reply: FastifyReply, ctx: AppContext, name: string, value: string, expiresAt: number) {
  void reply.setCookie(name, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    expires: new Date(expiresAt),
  });
}

export function clearCookie(reply: FastifyReply, ctx: AppContext, name: string) {
  void reply.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure });
}

export function cookie(req: FastifyRequest, name: string): string | undefined {
  return req.cookies[name];
}
