// Drops: flash drops (code, speed question, golden slip, everyone wins), the live feed, the hype
// meter and personal streaks. Routes under /api/drops.
import type { Ok } from '@afterhours/shared';
import {
  type AdminClaimsResponse,
  ClaimRequestSchema,
  type ClaimResponse,
  CreateDropRequestSchema,
  type CurrentDropResponse,
  DropSettingsPatchSchema,
  type DropsAdminState,
  FeedSayRequestSchema,
  type FeedState,
  type HypeState,
  type MyStreak,
  ResetDropsRequestSchema,
  ScheduleDropRequestSchema,
  type ScreenDropResponse,
  TapRequestSchema,
} from '@afterhours/shared/features/drops';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type FeatureContext,
  HttpError,
  RateLimiter,
  all,
  badRequest,
  defineFeature,
  getAttendee,
  isScreen,
  notFound,
  parse,
  requireAdmin,
  requireAttendee,
  requireScreen,
} from '../../core';
import { clearFeed, feedStateChanged, flushFeed, hideLine, recentFeed, say } from './feed';
import { LIBRARY, libraryDrop } from './library';
import { hypeState, hypeStep, pump, scheduleLines } from './pulse';
import {
  cancelDrop,
  challengeOf,
  claim,
  createDrop,
  currentDrop,
  deleteDrop,
  fireDrop,
  flushTally,
  getDrop,
  liveDrop,
  myClaim,
  nextTeaseAt,
  resetDrops,
  roomCount,
  scheduleDrop,
  settle,
  tallyOf,
  tap,
  toAdmin,
  toPublic,
  type DropRow,
} from './service';
import { getSettings, saveSettings } from './settings';
import { streakOf } from './streak';

interface Limits {
  claim: RateLimiter;
  tap: RateLimiter;
  taps: RateLimiter;
}
const limits = new WeakMap<FeatureContext, Limits>();
function limiter(ctx: FeatureContext): Limits {
  let l = limits.get(ctx);
  if (!l) {
    l = {
      // 8 answers burst, refilling over 8 s: enough to fix a typo, useless for guessing.
      claim: new RateLimiter({ limit: 8, windowMs: 8000, now: ctx.now }),
      // tap requests (the phone batches taps every ~300 ms)
      tap: new RateLimiter({ limit: 12, windowMs: 4000, now: ctx.now }),
      // individual taps: 5 a second sustained per person
      taps: new RateLimiter({ limit: 20, windowMs: 4000, now: ctx.now }),
    };
    limits.set(ctx, l);
  }
  return l;
}

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const LibParams = z.object({ lib: z.string().max(40) });
const LineParams = z.object({ line: z.string().max(40) });
const LibFire = z.object({ when: z.union([z.literal('now'), z.object({ at: z.number().int() })]).default('now') });

function dropId(req: FastifyRequest): number {
  return parse(IdParams, req.params).id;
}

/** One tick: read the bus, fire/close on time, coalesced broadcasts. Exported for tests (timers are off there). */
export function tick(ctx: FeatureContext): void {
  pump(ctx);
  settle(ctx);
  flushTally(ctx);
  hypeStep(ctx);
  scheduleLines(ctx);
  flushFeed(ctx);
}

function adminState(ctx: FeatureContext): DropsAdminState {
  settle(ctx);
  const rows = all<DropRow>(
    ctx.db,
    `SELECT * FROM drops_drops ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, COALESCE(fire_at, closed_at, created_at) DESC, id DESC LIMIT 60`,
  );
  const live = liveDrop(ctx);
  return {
    drops: rows.map((r) => toAdmin(ctx, r)),
    library: LIBRARY,
    settings: getSettings(ctx),
    feed: recentFeed(ctx, true),
    hype: hypeState(ctx),
    tally: live ? tallyOf(ctx, live) : null,
    serverNow: ctx.now(),
  };
}

export const drops = defineFeature({
  name: 'drops',

  stickers: [
    { id: 'drops-quickdraw', title: 'quick draw', hint: 'grab a top spot in a flash drop', shape: 'burst', color: 'sky', glyph: 'bolt', feature: 'drops', order: 60 },
    { id: 'drops-golden', title: 'golden slip', hint: 'find a golden slip before anyone else', shape: 'star', color: 'sun', glyph: 'crown', feature: 'drops', order: 61 },
    { id: 'drops-streak', title: 'on a roll', hint: 'do something in 3 activities in a row', shape: 'ticket', color: 'tangerine', glyph: 'flame', feature: 'drops', order: 62 },
  ],

  routes(app, ctx) {
    // ---- attendee ----------------------------------------------------------

    // GET /api/drops/current: the live drop (or the one that just closed), your claim, the tally.
    app.get('/current', async (req): Promise<CurrentDropResponse> => {
      const me = requireAttendee(req);
      settle(ctx);
      const row = currentDrop(ctx);
      return {
        drop: row ? toPublic(row) : null,
        tally: row ? tallyOf(ctx, row) : null,
        mine: row ? myClaim(ctx, row, me.attendeeId) : null,
        nextAt: nextTeaseAt(ctx),
        serverNow: ctx.now(),
      };
    });

    // POST /api/drops/:id/claim { answer }
    app.post('/:id/claim', async (req): Promise<ClaimResponse> => {
      const me = requireAttendee(req);
      const id = dropId(req);
      const { answer } = parse(ClaimRequestSchema, req.body);
      limiter(ctx).claim.enforce(`a:${me.attendeeId}`, 'Easy, one answer at a time.');
      return claim(ctx, id, me.attendeeId, answer);
    });

    // POST /api/drops/:id/tap { n }: the room drop's big button
    app.post('/:id/tap', async (req): Promise<{ count: number }> => {
      const me = requireAttendee(req);
      const id = dropId(req);
      const { n } = parse(TapRequestSchema, req.body);
      const l = limiter(ctx);
      l.tap.enforce(`a:${me.attendeeId}`, 'Your thumb is a machine. Breathe.');
      let ok = 0;
      for (let i = 0; i < n; i++) if (l.taps.hit(`a:${me.attendeeId}`)) ok++;
      if (ok === 0) return { count: roomCount(ctx) };
      return { count: tap(ctx, id, ok) };
    });

    // GET /api/drops/me: your streak
    app.get('/me', async (req): Promise<MyStreak> => {
      const me = requireAttendee(req);
      return streakOf(ctx, me.attendeeId);
    });

    // GET /api/drops/feed: attendees and the projector
    app.get('/feed', async (req): Promise<FeedState> => {
      if (!getAttendee(req) && !isScreen(req)) requireAttendee(req);
      const muted = getSettings(ctx).feedMuted;
      return { items: muted ? [] : recentFeed(ctx).map(({ hidden: _h, ...it }) => it), muted };
    });

    // ---- projector -----------------------------------------------------------

    // GET /api/drops/screen
    app.get('/screen', async (req): Promise<ScreenDropResponse> => {
      requireScreen(req);
      settle(ctx);
      const row = currentDrop(ctx);
      return {
        drop: row ? toPublic(row) : null,
        challenge: row ? challengeOf(row) : null,
        tally: row ? tallyOf(ctx, row) : null,
        nextAt: nextTeaseAt(ctx),
        serverNow: ctx.now(),
      };
    });

    // GET /api/drops/hype
    app.get('/hype', async (req): Promise<HypeState> => {
      requireScreen(req);
      return hypeState(ctx);
    });

    // ---- console ---------------------------------------------------------------

    app.get('/admin', async (req): Promise<DropsAdminState> => {
      requireAdmin(req);
      return adminState(ctx);
    });

    // POST /api/drops/admin { title, blurb, durationSec, config, when: 'now' | 'draft' | { at } }
    app.post('/admin', async (req) => {
      requireAdmin(req);
      const body = parse(CreateDropRequestSchema, req.body);
      const { when, ...input } = body;
      if (typeof when === 'object' && when.at <= ctx.now()) throw badRequest('Pick a time in the future.');
      if (when === 'now' && liveDrop(ctx)) throw new HttpError(409, 'conflict', 'One drop at a time. Wait for the live one or cancel it.');
      const row = createDrop(ctx, input, { fireAt: typeof when === 'object' ? when.at : null });
      const out = when === 'now' ? fireDrop(ctx, row.id) : row;
      return toAdmin(ctx, out);
    });

    // POST /api/drops/admin/library/:lib { when? }: two taps from the library
    app.post('/admin/library/:lib', async (req) => {
      requireAdmin(req);
      const { lib } = parse(LibParams, req.params);
      const input = libraryDrop(lib);
      if (!input) throw notFound('No such library drop.');
      const { when } = parse(LibFire, req.body ?? {});
      if (when === 'now' && liveDrop(ctx)) throw new HttpError(409, 'conflict', 'One drop at a time. Wait for the live one or cancel it.');
      if (typeof when === 'object' && when.at <= ctx.now()) throw badRequest('Pick a time in the future.');
      const row = createDrop(ctx, input, { fireAt: typeof when === 'object' ? when.at : null, library: lib });
      return toAdmin(ctx, when === 'now' ? fireDrop(ctx, row.id) : row);
    });

    app.post('/admin/:id/fire', async (req) => {
      requireAdmin(req);
      return toAdmin(ctx, fireDrop(ctx, dropId(req)));
    });

    app.post('/admin/:id/schedule', async (req) => {
      requireAdmin(req);
      const { at } = parse(ScheduleDropRequestSchema, req.body);
      if (at <= ctx.now()) throw badRequest('Pick a time in the future.');
      return toAdmin(ctx, scheduleDrop(ctx, dropId(req), at));
    });

    app.post('/admin/:id/cancel', async (req) => {
      requireAdmin(req);
      return toAdmin(ctx, cancelDrop(ctx, dropId(req)));
    });

    app.delete('/admin/:id', async (req): Promise<Ok> => {
      requireAdmin(req);
      deleteDrop(ctx, dropId(req));
      return { ok: true };
    });

    // GET /api/drops/admin/:id/claims: who got it, in order
    app.get('/admin/:id/claims', async (req): Promise<AdminClaimsResponse> => {
      requireAdmin(req);
      const id = dropId(req);
      if (!getDrop(ctx, id)) throw notFound('No such drop.');
      const rows = all<{ nickname: string | null; kit_id: string; correct: number; rank: number | null; points: number; attempts: number; at: number }>(
        ctx.db,
        `SELECT a.nickname, a.kit_id, c.correct, c.rank, c.points, c.attempts, c.at FROM drops_claims c JOIN attendees a ON a.id = c.attendee_id
          WHERE c.drop_id = ? ORDER BY c.rank IS NULL, c.rank, c.at LIMIT 500`,
        id,
      );
      return {
        claims: rows.map((r) => ({ nickname: r.nickname ?? '?', kitId: r.kit_id, correct: r.correct === 1, rank: r.rank, points: r.points, attempts: r.attempts, at: r.at })),
      };
    });

    app.patch('/admin/settings', async (req) => {
      requireAdmin(req);
      const patch = parse(DropSettingsPatchSchema, req.body);
      const before = getSettings(ctx);
      const next = saveSettings(ctx, patch);
      if (before.feedMuted !== next.feedMuted) feedStateChanged(ctx);
      if (before.hypeEnabled !== next.hypeEnabled || before.hypeTarget !== next.hypeTarget) hypeStep(ctx, true);
      return next;
    });

    app.post('/admin/feed', async (req): Promise<Ok> => {
      requireAdmin(req);
      const { text } = parse(FeedSayRequestSchema, req.body);
      say(ctx, text);
      return { ok: true };
    });

    app.post('/admin/feed/:line/hide', async (req): Promise<Ok> => {
      requireAdmin(req);
      const { line } = parse(LineParams, req.params);
      if (!hideLine(ctx, line)) throw notFound('That line is gone already.');
      return { ok: true };
    });

    app.post('/admin/reset', async (req): Promise<Ok> => {
      requireAdmin(req);
      parse(ResetDropsRequestSchema, req.body);
      resetDrops(ctx);
      clearFeed(ctx);
      feedStateChanged(ctx);
      return { ok: true };
    });
  },

  // Start reading the bus from now (nothing from before boot ends up in the feed).
  boot: (ctx) => pump(ctx),

  tick: { everyMs: 400, run: tick },

  seed(ctx) {
    // Two drafts so the console is not empty on a demo; the library has the rest.
    const a = libraryDrop('code-sudo');
    const b = libraryDrop('room-200');
    if (a) createDrop(ctx, a, { library: 'code-sudo' });
    if (b) createDrop(ctx, b, { library: 'room-200' });
    say(ctx, 'welcome to after hours. drops land without warning, keep your phone close');
  },
});
