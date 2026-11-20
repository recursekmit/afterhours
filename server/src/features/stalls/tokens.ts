// Short-lived signed things: the rotating QR token, the typed code, and the counter ticket.
//
//   token  = <attendee base36>.<window base36>.<hmac>   (QR / URL safe; current or previous window only)
//   code   = 6 chars derived from the same secret, also bound to attendee + window (typed fallback)
//   ticket = signed {attendee, stall, expiry}: "this person is at your counter" for a few minutes
//
// The secret is random, stored in the database on first use, and never leaves the server.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { QR_WINDOW_MS, TICKET_MS, TYPED_CODE_LEN } from '@afterhours/shared/features/stalls';
import { type FeatureContext, all, one, run } from '../../core';

const secrets = new WeakMap<FeatureContext, Buffer>();

export function secretOf(ctx: FeatureContext): Buffer {
  let s = secrets.get(ctx);
  if (s) return s;
  const row = one<{ value: string }>(ctx.db, "SELECT value FROM stalls_meta WHERE key = 'secret'");
  if (row) s = Buffer.from(row.value, 'hex');
  else {
    s = randomBytes(32);
    run(ctx.db, "INSERT OR IGNORE INTO stalls_meta (key, value) VALUES ('secret', ?)", s.toString('hex'));
    s = Buffer.from(one<{ value: string }>(ctx.db, "SELECT value FROM stalls_meta WHERE key = 'secret'")?.value ?? '', 'hex');
  }
  secrets.set(ctx, s);
  return s;
}

const mac = (ctx: FeatureContext, data: string): Buffer => createHmac('sha256', secretOf(ctx)).update(data).digest();

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const windowOf = (now: number): number => Math.floor(now / QR_WINDOW_MS);

export function makeToken(ctx: FeatureContext, attendeeId: number, now: number): string {
  const w = windowOf(now);
  return `${attendeeId.toString(36)}.${w.toString(36)}.${mac(ctx, `q.${attendeeId}.${w}`).subarray(0, 12).toString('base64url')}`;
}

/** The attendee a token belongs to, or null if forged, malformed or older than the previous window. */
export function verifyToken(ctx: FeatureContext, token: string, now: number): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [a, w, sig] = parts as [string, string, string];
  if (!/^[0-9a-z]{1,8}$/.test(a) || !/^[0-9a-z]{1,10}$/.test(w) || sig.length !== 16) return null;
  const attendeeId = parseInt(a, 36);
  const win = parseInt(w, 36);
  const cur = windowOf(now);
  if (!Number.isSafeInteger(attendeeId) || attendeeId < 1 || (win !== cur && win !== cur - 1)) return null;
  const want = mac(ctx, `q.${attendeeId}.${win}`).subarray(0, 12).toString('base64url');
  return safeEqual(want, sig) ? attendeeId : null;
}

/** No 0, 1, I, L or O: easy to read off a phone across a counter. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function makeCode(ctx: FeatureContext, attendeeId: number, now: number): string {
  return codeFor(ctx, attendeeId, windowOf(now));
}

function codeFor(ctx: FeatureContext, attendeeId: number, win: number): string {
  const h = mac(ctx, `c.${attendeeId}.${win}`);
  let out = '';
  for (let i = 0; i < TYPED_CODE_LEN; i++) out += ALPHABET[(h[i] ?? 0) % ALPHABET.length];
  return out;
}

export const normaliseCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Which attendee shows this typed code right now (current or previous window)? Null when nobody does, or
 * when two people happen to share it (the shopkeeper then scans the QR instead).
 */
export function resolveCode(ctx: FeatureContext, raw: string, now: number): number | null {
  const code = normaliseCode(raw);
  if (code.length !== TYPED_CODE_LEN) return null;
  const cur = windowOf(now);
  let found: number | null = null;
  for (const { id } of all<{ id: number }>(ctx.db, 'SELECT id FROM attendees WHERE profile_complete = 1')) {
    for (const w of [cur, cur - 1]) {
      if (codeFor(ctx, id, w) === code) {
        if (found !== null && found !== id) return null;
        found = id;
      }
    }
  }
  return found;
}

export function makeTicket(ctx: FeatureContext, attendeeId: number, stallId: number, now: number): { ticket: string; expiresAt: number } {
  const expiresAt = now + TICKET_MS;
  // The nonce makes every scan a distinct ticket, so one ticket can be spent exactly once.
  const body = `${attendeeId.toString(36)}.${stallId.toString(36)}.${expiresAt.toString(36)}.${randomBytes(5).toString('hex')}`;
  return { ticket: `${body}.${mac(ctx, `t.${body}`).subarray(0, 12).toString('base64url')}`, expiresAt };
}

export function verifyTicket(ctx: FeatureContext, ticket: string, stallId: number, now: number): { attendeeId: number } | null {
  const parts = ticket.split('.');
  if (parts.length !== 5) return null;
  const [a, s, e, n, sig] = parts as [string, string, string, string, string];
  if (!/^[0-9a-z]{1,8}$/.test(a) || !/^[0-9a-z]{1,8}$/.test(s) || !/^[0-9a-z]{1,12}$/.test(e) || !/^[0-9a-f]{10}$/.test(n)) return null;
  const want = mac(ctx, `t.${a}.${s}.${e}.${n}`).subarray(0, 12).toString('base64url');
  if (!safeEqual(want, sig)) return null;
  if (parseInt(s, 36) !== stallId || parseInt(e, 36) < now) return null;
  return { attendeeId: parseInt(a, 36) };
}

/** Pull the token out of a scanned URL (`.../stall/r/<token>`), or return the input untouched. */
export function extractToken(input: string): string {
  const m = /\/stall\/r\/([0-9a-z._-]+)/i.exec(input);
  return (m?.[1] ?? input).trim();
}
