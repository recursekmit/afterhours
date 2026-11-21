import {
  GenerateKitsRequestSchema,
  type GenerateKitsResponse,
  type KitListResponse,
  type MeResponse,
  type Ok,
  PinRequestSchema,
  ProfileInputSchema,
  ResetKitRequestSchema,
  type ResetKitResponse,
  SignInRequestSchema,
  type StaffMe,
  type StaffRole,
  KitIdSchema,
} from '@afterhours/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { one, run, tx } from '../db';
import { HttpError, unauthorized } from '../errors';
import { RateLimiter } from '../ratelimit';
import { parse } from '../validate';
import { getMe, saveProfile } from './attendees';
import { getDummyHash, newToken, safeEqual, sha256, verifyPassword } from './crypto';
import { requireAdmin, requireAttendee } from './guards';
import { mayUseAnyPhone, registerIdLoginRoutes } from './idRoutes';
import { generateKits, listKits, parseKitCsv, resetKit } from './kits';
import { COOKIES, clearCookie, createSession, deleteSession, findSession, setCookie } from './sessions';

const DEVICE_COOKIE_DAYS = 30;

export const SIGNIN_POINTS = 10;
export const PROFILE_POINTS = 10;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const { login } = ctx.config;
  const ipLimiter = new RateLimiter({ limit: login.ipPerMin, windowMs: 60_000, now: ctx.now });
  const kitFailLimiter = new RateLimiter({ limit: login.kitFails, windowMs: login.kitWindowMs, now: ctx.now });
  const pinFailLimiter = new RateLimiter({ limit: 8, windowMs: 5 * 60_000, now: ctx.now });
  const sweep = setInterval(() => {
    ipLimiter.sweep();
    kitFailLimiter.sweep();
    pinFailLimiter.sweep();
  }, 60_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  /* ------------------------------------------------------- attendee */

  app.post('/api/auth/signin', async (req, reply): Promise<MeResponse> => {
    ipLimiter.enforce(`ip:${req.ip}`, 'Lots of sign-ins from this network. Give it a few seconds.');
    const body = parse(SignInRequestSchema, req.body);
    const kitKey = `kit:${body.kitId}`;
    if (!kitFailLimiter.allowed(kitKey)) {
      throw new HttpError(429, 'rate_limited', 'Too many wrong tries on this kit. Wait a bit, or come to the desk.', {
        retryAfter: Math.max(1, kitFailLimiter.retryAfter(kitKey)),
      });
    }
    const kit = one<{ id: string; password_hash: string }>(
      ctx.db,
      "SELECT id, password_hash FROM kits WHERE id = ? AND kind = 'card'",
      body.kitId,
    );
    // Always run scrypt so a missing kit and a wrong password take the same time.
    const ok = await verifyPassword(body.password, kit?.password_hash ?? (await getDummyHash()));
    if (!kit || !ok) {
      kitFailLimiter.hit(kitKey);
      throw new HttpError(401, 'bad_credentials', "That kit ID and password don't match. Check your card?");
    }
    // Event day: a kit can be signed in again on any phone too (see mayUseAnyPhone).
    const me = signInToKit(req, reply, kit.id, () => new HttpError(409, 'kit_bound', 'This kit is already signed in on another phone. Ask the desk to reset it.'), { rebind: mayUseAnyPhone() });
    kitFailLimiter.reset(kitKey);
    return me;
  });

  /**
   * Bind a kit (printed card or a participant's roster kit) to this phone and
   * sign in. First sign-in creates the attendee: that is the attendance record.
   * Throws `bound()` if the kit is already bound to another phone, unless
   * `rebind` is set (mock testers): then this phone simply takes the kit over.
   */
  function signInToKit(req: FastifyRequest, reply: FastifyReply, kitId: string, bound: () => HttpError, opts: { rebind?: boolean } = {}): MeResponse {
    let deviceToken = req.cookies[COOKIES.device];
    if (!deviceToken || !/^[A-Za-z0-9_-]{20,100}$/.test(deviceToken)) deviceToken = newToken();
    const deviceHash = sha256(deviceToken);
    const now = ctx.now();

    const outcome = tx(ctx.db, () => {
      // Atomic bind: succeeds if the kit is unbound or already bound to this browser.
      const bind = run(
        ctx.db,
        `UPDATE kits SET device_hash = ?, bound_at = COALESCE(bound_at, ?)
          WHERE id = ? AND (device_hash IS NULL OR device_hash = ? OR ?)`,
        deviceHash,
        now,
        kitId,
        deviceHash,
        opts.rebind ? 1 : 0,
      );
      if (bind.changes === 0) return null;
      const kit = one<{ preset_name: string | null; preset_roll: string | null }>(ctx.db, 'SELECT preset_name, preset_roll FROM kits WHERE id = ?', kitId);
      let attendee = one<{ id: number }>(ctx.db, 'SELECT id FROM attendees WHERE kit_id = ?', kitId);
      let first = false;
      if (!attendee) {
        const ins = run(
          ctx.db,
          'INSERT INTO attendees (kit_id, name, roll, first_signin_at) VALUES (?, ?, ?, ?)',
          kitId,
          kit?.preset_name ?? null,
          kit?.preset_roll ?? null,
          now,
        );
        attendee = { id: ins.lastId };
        first = true;
      }
      const session = createSession(ctx, 'attendee', attendee.id);
      return { attendeeId: attendee.id, first, session };
    });

    if (!outcome) throw bound();
    setCookie(reply, ctx, COOKIES.device, deviceToken, now + DEVICE_COOKIE_DAYS * 86_400_000);
    setCookie(reply, ctx, COOKIES.attendee, outcome.session.token, outcome.session.expiresAt);
    if (outcome.first) {
      ctx.points.award({ attendeeId: outcome.attendeeId, source: 'core', ref: 'signin', points: SIGNIN_POINTS, label: 'showed up' });
      ctx.stickers.unlock(outcome.attendeeId, 'showed-up');
    }
    return getMe(ctx, outcome.attendeeId);
  }

  registerIdLoginRoutes(app, ctx, { ipLimiter, signInToKit });

  app.post('/api/auth/signout', async (req, reply): Promise<Ok> => {
    deleteSession(ctx, req.cookies[COOKIES.attendee]);
    clearCookie(reply, ctx, COOKIES.attendee);
    return { ok: true };
  });

  app.get('/api/me', async (req): Promise<MeResponse> => {
    const me = requireAttendee(req, { allowIncompleteProfile: true });
    return getMe(ctx, me.attendeeId);
  });

  app.put('/api/me/profile', async (req): Promise<MeResponse> => {
    const me = requireAttendee(req, { allowIncompleteProfile: true });
    const body = parse(ProfileInputSchema, req.body);
    const { first } = saveProfile(ctx, me.attendeeId, body);
    if (first) {
      ctx.points.award({ attendeeId: me.attendeeId, source: 'core', ref: 'profile', points: PROFILE_POINTS, label: 'made a face' });
      ctx.stickers.unlock(me.attendeeId, 'new-face');
    }
    return getMe(ctx, me.attendeeId);
  });

  /* ---------------------------------------------------- staff PINs */

  const staffCookie = (role: StaffRole) => (role === 'admin' ? COOKIES.admin : role === 'screen' ? COOKIES.screen : COOKIES.gate);
  const staffNeedMsg = (role: StaffRole) => (role === 'admin' ? 'Console PIN needed.' : role === 'screen' ? 'Projector PIN needed.' : 'Gate PIN needed.');

  const staffLogin = (role: StaffRole, pin: string) => async (req: FastifyRequest, reply: FastifyReply): Promise<StaffMe> => {
    const key = `pin:${req.ip}`;
    if (!pinFailLimiter.allowed(key)) {
      throw new HttpError(429, 'rate_limited', 'Too many wrong PINs. Wait a few minutes.', { retryAfter: pinFailLimiter.retryAfter(key) });
    }
    const body = parse(PinRequestSchema, req.body);
    if (!safeEqual(body.pin, pin)) {
      pinFailLimiter.hit(key);
      throw new HttpError(401, 'bad_credentials', 'Wrong PIN.');
    }
    const s = createSession(ctx, role, null);
    setCookie(reply, ctx, staffCookie(role), s.token, s.expiresAt);
    return { role };
  };
  const staffMe = (role: StaffRole) => async (req: FastifyRequest): Promise<StaffMe> => {
    if (!findSession(ctx, role, req.cookies[staffCookie(role)])) {
      throw unauthorized(staffNeedMsg(role));
    }
    return { role };
  };
  const staffLogout = (role: StaffRole) => async (req: FastifyRequest, reply: FastifyReply): Promise<Ok> => {
    const name = staffCookie(role);
    deleteSession(ctx, req.cookies[name]);
    clearCookie(reply, ctx, name);
    return { ok: true };
  };

  app.post('/api/admin/session', staffLogin('admin', ctx.config.adminPin));
  app.get('/api/admin/session', staffMe('admin'));
  app.delete('/api/admin/session', staffLogout('admin'));
  app.post('/api/screen/session', staffLogin('screen', ctx.config.screenPin));
  app.get('/api/screen/session', staffMe('screen'));
  app.delete('/api/screen/session', staffLogout('screen'));
  app.post('/api/gate/session', staffLogin('gate', ctx.config.gatePin));
  app.get('/api/gate/session', staffMe('gate'));
  app.delete('/api/gate/session', staffLogout('gate'));

  /* ---------------------------------------------------- admin: kits */

  app.post('/api/admin/kits', async (req): Promise<GenerateKitsResponse> => {
    requireAdmin(req);
    const body = parse(GenerateKitsRequestSchema, req.body);
    if (body.mode === 'blank') {
      const kits = await generateKits(ctx, Array.from({ length: body.count }, () => ({ name: null, roll: null })));
      return { kits, skipped: [] };
    }
    const { rows, skipped } = parseKitCsv(body.csv);
    if (rows.length > 500) throw new HttpError(400, 'bad_request', 'Max 500 kits at a time. Split the list.');
    const kits = rows.length ? await generateKits(ctx, rows) : [];
    return { kits, skipped };
  });

  app.get('/api/admin/kits', async (req): Promise<KitListResponse> => {
    requireAdmin(req);
    return listKits(ctx);
  });

  app.post<{ Params: { kitId: string } }>('/api/admin/kits/:kitId/reset', async (req): Promise<ResetKitResponse> => {
    requireAdmin(req);
    const kitId = parse(KitIdSchema, req.params.kitId);
    const body = parse(ResetKitRequestSchema, req.body ?? {});
    return resetKit(ctx, kitId, body.newPassword);
  });
}
