/*
  Student-ID login routes (spec 4.1).

  Phone:
    POST /api/auth/id/resolve   { payload, roll? }          who is this card? (no side effects)
    POST /api/auth/id/signin    { payload, roll?, phone4? } bind this phone and sign in
    POST /api/auth/roll/signin  { roll, phone4 }            typed fallback: full roll + last 4 phone digits
  Console:
    GET    /api/admin/participants                 roster, sign-in state, points, settings
    POST   /api/admin/participants/import { csv }  import a CSV/TSV, returns the duplicate/conflict report
    POST   /api/admin/participants                 add one (walk-in)
    PUT    /api/admin/participants/:id             edit
    DELETE /api/admin/participants/:id             remove (only before they sign in)
    POST   /api/admin/participants/:id/unbind      free them for another phone
    PUT    /api/admin/idlogin/settings { strictPhone }
    POST   /api/admin/desk/lookup { q }            desk mode: a scanned card, a roll or a name

  A student-ID QR is not a secret. What protects people: one phone per ID (the
  first phone wins, the desk can unbind), a clear "already signed in on another
  phone" message, an optional "also ask the last 4 phone digits" setting, and
  the typed fallback never saying whether a roll exists until the digits match.
*/
import {
  DeskLookupRequestSchema,
  type DeskLookupResponse,
  IdResolveRequestSchema,
  type IdResolveResponse,
  IdSignInRequestSchema,
  ImportParticipantsRequestSchema,
  type ImportReport,
  type MeResponse,
  type Ok,
  ParticipantInputSchema,
  type ParticipantListResponse,
  type ParticipantRow,
  ParticipantSettingsSchema,
  RollSignInRequestSchema,
  parseIdQr,
  phoneLast4,
  resolveIdQr,
  rollKey,
  rollSuffix,
} from '@afterhours/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { one } from '../db';
import { HttpError } from '../errors';
import { RateLimiter } from '../ratelimit';
import { parse } from '../validate';
import { safeEqual, sha256 } from './crypto';
import { requireAdmin } from './guards';
import {
  type RosterEntry,
  addParticipant,
  deskLookup,
  findByRoll,
  getIdLoginSettings,
  importParticipants,
  listParticipants,
  removeParticipant,
  roster,
  setIdLoginSettings,
  unbindParticipant,
  updateParticipant,
} from './participants';
import { COOKIES } from './sessions';

export interface IdLoginDeps {
  ipLimiter: RateLimiter;
  signInToKit: (req: FastifyRequest, reply: FastifyReply, kitId: string, bound: () => HttpError) => MeResponse;
}

const idBound = () =>
  new HttpError(409, 'id_bound', 'This ID is already signed in on another phone. If that was not you, show this screen at the entry desk and they will sort it out.');
const notRegistered = () => new HttpError(404, 'not_registered', "You're not on the list. Show this screen at the entry desk and they'll add you.");

/** "S Hemanth Rao" -> "Hemanth", "THOTA ROSHINI" -> "Thota". */
export function friendlyFirstName(name: string): string {
  const words = name.split(/\s+/).map((w) => w.replace(/[^\p{L}]/gu, ''));
  const w = words.find((x) => x.length >= 2) ?? name.trim();
  return w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w;
}

function phoneMatches(registered: string | null, typed: string): boolean {
  const last4 = phoneLast4(registered);
  // Always compare, even with nothing registered, so the timing does not say which.
  return safeEqual(last4.length === 4 ? last4 : '\u0000none', typed) && last4.length === 4;
}

const IdParam = z.coerce.number().int().positive();

export function registerIdLoginRoutes(app: FastifyInstance, ctx: AppContext, deps: IdLoginDeps) {
  const { login } = ctx.config;
  const { ipLimiter, signInToKit } = deps;
  // Resolving a scan is a separate bucket of the same size, so the two-step
  // scan -> confirm flow does not halve the sign-ins a shared Wi-Fi gets.
  const resolveLimiter = new RateLimiter({ limit: login.ipPerMin, windowMs: 60_000, now: ctx.now });
  const rollFailLimiter = new RateLimiter({ limit: login.kitFails, windowMs: login.kitWindowMs, now: ctx.now });
  // Per network: generous, a whole college shares one NAT address.
  const ipFailLimiter = new RateLimiter({ limit: login.kitFails * 6, windowMs: login.kitWindowMs, now: ctx.now });
  const sweep = setInterval(() => {
    resolveLimiter.sweep();
    rollFailLimiter.sweep();
    ipFailLimiter.sweep();
  }, 60_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  const tooMany = (key: string, limiter: RateLimiter) =>
    new HttpError(429, 'rate_limited', 'Too many wrong tries. Wait a few minutes, or come to the entry desk.', { retryAfter: Math.max(1, limiter.retryAfter(key)) });

  function thisDevice(req: FastifyRequest): string | null {
    const t = req.cookies[COOKIES.device];
    return t && /^[A-Za-z0-9_-]{20,100}$/.test(t) ? sha256(t) : null;
  }

  function boundElsewhere(req: FastifyRequest, who: RosterEntry): { elsewhere: boolean; here: boolean } {
    const k = one<{ device_hash: string | null }>(ctx.db, 'SELECT device_hash FROM kits WHERE id = ?', who.kitId);
    const mine = thisDevice(req);
    const here = Boolean(k?.device_hash && mine && k.device_hash === mine);
    return { elsewhere: Boolean(k?.device_hash) && !here, here };
  }

  /** The registered person a scanned card (plus, if asked, their full roll) points at. */
  function resolveScan(body: { payload: string; roll?: string | undefined }): RosterEntry {
    const qr = parseIdQr(body.payload);
    if (!qr) throw new HttpError(400, 'bad_qr', "That QR isn't a college ID. Scan the QR on your student ID card, or type your roll number instead.");
    const list = roster(ctx);
    if (body.roll) {
      // Answering "which one are you?": it has to be a roll this card could be.
      const fits = qr.roll ? rollKey(qr.roll) === rollKey(body.roll) : rollSuffix(body.roll) === rollKey(qr.suffix);
      if (!fits) throw new HttpError(400, 'bad_request', `That roll number doesn't end in ${qr.roll ? qr.roll.slice(-4) : qr.suffix}, like the one on your card.`);
      const key = rollKey(body.roll);
      const who = list.find((p) => rollKey(p.roll) === key);
      if (!who) throw notRegistered();
      return who;
    }
    const res = resolveIdQr(qr, list);
    if (res.kind === 'none') throw notRegistered();
    if (res.kind === 'ambiguous') {
      throw new HttpError(409, 'need_roll', `More than one roll on our list ends in ${qr.suffix}. Type your full roll number so we get the right you.`);
    }
    return res.who;
  }

  /* -------------------------------------------------------------- phone */

  app.post('/api/auth/id/resolve', async (req): Promise<IdResolveResponse> => {
    resolveLimiter.enforce(`ip:${req.ip}`, 'Lots of scans from this network. Give it a few seconds.');
    const body = parse(IdResolveRequestSchema, req.body);
    const who = resolveScan(body);
    const { elsewhere, here } = boundElsewhere(req, who);
    if (elsewhere) throw idBound();
    return { firstName: friendlyFirstName(who.name), roll: who.roll, needPhone: getIdLoginSettings(ctx).strictPhone && !here, thisPhone: here };
  });

  app.post('/api/auth/id/signin', async (req, reply): Promise<MeResponse> => {
    ipLimiter.enforce(`ip:${req.ip}`, 'Lots of sign-ins from this network. Give it a few seconds.');
    const body = parse(IdSignInRequestSchema, req.body);
    const who = resolveScan(body);
    const { elsewhere, here } = boundElsewhere(req, who);
    if (elsewhere) throw idBound();
    if (getIdLoginSettings(ctx).strictPhone && !here) {
      const key = `roll:${rollKey(who.roll)}`;
      if (!rollFailLimiter.allowed(key)) throw tooMany(key, rollFailLimiter);
      if (!body.phone4 || !phoneMatches(who.phone, body.phone4)) {
        rollFailLimiter.hit(key);
        throw new HttpError(401, 'bad_credentials', "Those aren't the last 4 digits of the phone number you registered with. Try again, or ask the desk.");
      }
      rollFailLimiter.reset(key);
    }
    return signInToKit(req, reply, who.kitId, idBound);
  });

  app.post('/api/auth/roll/signin', async (req, reply): Promise<MeResponse> => {
    ipLimiter.enforce(`ip:${req.ip}`, 'Lots of sign-ins from this network. Give it a few seconds.');
    const body = parse(RollSignInRequestSchema, req.body);
    const rollKeyName = `roll:${rollKey(body.roll)}`;
    const ipKey = `ip:${req.ip}`;
    // Checked before looking the roll up: a limit says nothing about whether the roll exists.
    if (!rollFailLimiter.allowed(rollKeyName)) throw tooMany(rollKeyName, rollFailLimiter);
    if (!ipFailLimiter.allowed(ipKey)) throw tooMany(ipKey, ipFailLimiter);
    const who = findByRoll(ctx, body.roll);
    const ok = phoneMatches(who?.phone ?? null, body.phone4) && who !== null;
    if (!ok || !who) {
      rollFailLimiter.hit(rollKeyName);
      ipFailLimiter.hit(ipKey);
      // One message for "no such roll" and "wrong digits": nothing leaks before the digits match.
      throw new HttpError(401, 'bad_credentials', "That roll number and those phone digits don't match our list. Check both, or show this screen at the entry desk.");
    }
    rollFailLimiter.reset(rollKeyName);
    return signInToKit(req, reply, who.kitId, idBound);
  });

  /* ------------------------------------------------------------ console */

  app.get('/api/admin/participants', async (req): Promise<ParticipantListResponse> => {
    requireAdmin(req);
    return listParticipants(ctx);
  });

  app.post('/api/admin/participants/import', async (req): Promise<ImportReport> => {
    requireAdmin(req);
    const body = parse(ImportParticipantsRequestSchema, req.body);
    if (body.csv.split('\n').length > 2001) throw new HttpError(400, 'bad_request', 'Max 2000 people at a time. Split the list.');
    return importParticipants(ctx, body.csv);
  });

  app.post('/api/admin/participants', async (req): Promise<ParticipantRow> => {
    requireAdmin(req);
    return addParticipant(ctx, parse(ParticipantInputSchema, req.body), 'walkin');
  });

  app.put<{ Params: { id: string } }>('/api/admin/participants/:id', async (req): Promise<ParticipantRow> => {
    requireAdmin(req);
    return updateParticipant(ctx, parse(IdParam, req.params.id), parse(ParticipantInputSchema, req.body));
  });

  app.delete<{ Params: { id: string } }>('/api/admin/participants/:id', async (req): Promise<Ok> => {
    requireAdmin(req);
    removeParticipant(ctx, parse(IdParam, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/participants/:id/unbind', async (req): Promise<ParticipantRow> => {
    requireAdmin(req);
    return unbindParticipant(ctx, parse(IdParam, req.params.id));
  });

  app.put('/api/admin/idlogin/settings', async (req): Promise<{ strictPhone: boolean }> => {
    requireAdmin(req);
    return setIdLoginSettings(ctx, parse(ParticipantSettingsSchema, req.body));
  });

  app.post('/api/admin/desk/lookup', async (req): Promise<DeskLookupResponse> => {
    requireAdmin(req);
    return deskLookup(ctx, parse(DeskLookupRequestSchema, req.body).q);
  });
}
