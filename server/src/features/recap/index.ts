// Recap: your After Hours, as a story. One endpoint builds a person's whole afternoon from the points
// ledger plus read-only queries of each feature (service.ts); the projector gets the room's totals; the
// sticker book gets live rarity; the console gets the "recap open" switch and a preview of anyone's recap.
//
// Opens when the console flips it, or by itself once the final leaderboard reveal is done.
import type { Ok } from '@afterhours/shared';
import {
  type Recap,
  RecapAttendeeQuerySchema,
  type RecapAttendeeList,
  RecapOpenRequestSchema,
  RecapSeenRequestSchema,
  RecapSlapsRequestSchema,
  type RecapStatus,
  type RoomRecap,
  type StickerRarity,
} from '@afterhours/shared/features/recap';
import { z } from 'zod';
import {
  type FeatureContext,
  HttpError,
  RateLimiter,
  all,
  defineFeature,
  getAttendee,
  isScreen,
  notFound,
  one,
  parse,
  requireAdmin,
  requireAttendee,
  requireScreen,
  run,
  unauthorized,
} from '../../core';
import { buildRecap, invalidateRecap, recapStatus, roomRecap, setRecapOpen, stickerRarity } from './service';

export { buildRecap, recapStatus, roomRecap, stickerRarity, invalidateRecap } from './service';

/** Slaps needed for the secret "slap happy" sticker. */
export const SLAP_HAPPY_AT = 20;

export const RECAP_STICKERS = {
  rewind: 'recap-rewind',
  shared: 'recap-shared',
  slaps: 'recap-slap-happy',
} as const;

interface State {
  limiter: RateLimiter;
  lastStatus: string;
}
const states = new WeakMap<FeatureContext, State>();
function state(ctx: FeatureContext): State {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { limiter: new RateLimiter({ limit: 20, windowMs: 10_000, now: ctx.now }), lastStatus: '' }));
  return s;
}

const locked = () => new HttpError(403, 'recap_locked', 'Your recap unlocks right after the final reveal. Hang tight.');

function publishStatus(ctx: FeatureContext, st: RecapStatus): void {
  const key = JSON.stringify(st);
  const s = state(ctx);
  if (key === s.lastStatus) return;
  s.lastStatus = key;
  ctx.live.publish('recap.status', st, 'all');
}

/** Tick: notice the reveal finishing (or a freeze starting) and tell every phone once. */
export function tick(ctx: FeatureContext): void {
  publishStatus(ctx, recapStatus(ctx));
}

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export const recap = defineFeature({
  name: 'recap',

  stickers: [
    { id: RECAP_STICKERS.rewind, title: 'rewind', hint: 'watch your whole recap, start to end', shape: 'circle', color: 'grape', glyph: 'arrow', feature: 'recap', order: 90 },
    { id: RECAP_STICKERS.shared, title: 'show-off', hint: 'share your recap story', shape: 'heart', color: 'pink', glyph: 'heart', feature: 'recap', order: 91 },
    { id: RECAP_STICKERS.slaps, title: 'slap happy', hint: `slap ${SLAP_HAPPY_AT} stickers in your book`, shape: 'burst', color: 'sun', glyph: 'spark', feature: 'recap', order: 92 },
  ],

  boot(ctx) {
    state(ctx).lastStatus = JSON.stringify(recapStatus(ctx));
  },

  routes(app, ctx) {
    // GET /api/recap/status: attendee, projector, console
    app.get('/status', async (req): Promise<RecapStatus> => {
      if (!getAttendee(req) && !isScreen(req)) throw unauthorized();
      return recapStatus(ctx);
    });

    // GET /api/recap/me: your whole afternoon (403 recap_locked until it opens)
    app.get('/me', async (req): Promise<Recap> => {
      const me = requireAttendee(req);
      if (!recapStatus(ctx).open) throw locked();
      const r = buildRecap(ctx, me.attendeeId);
      if (!r) throw notFound('No such attendee.');
      return r;
    });

    // POST /api/recap/me/seen { cards }: watched it to the end -> secret sticker
    app.post('/me/seen', async (req): Promise<Ok> => {
      const me = requireAttendee(req);
      parse(RecapSeenRequestSchema, req.body);
      if (!recapStatus(ctx).open) throw locked();
      ctx.stickers.unlock(me.attendeeId, RECAP_STICKERS.rewind);
      return { ok: true };
    });

    // POST /api/recap/me/shared: shared (or saved) the story image -> secret sticker
    app.post('/me/shared', async (req): Promise<Ok> => {
      const me = requireAttendee(req);
      if (!recapStatus(ctx).open) throw locked();
      ctx.stickers.unlock(me.attendeeId, RECAP_STICKERS.shared);
      return { ok: true };
    });

    // POST /api/recap/me/slaps { count }: slaps since the last report. No points, just a sticker.
    app.post('/me/slaps', async (req): Promise<{ total: number }> => {
      const me = requireAttendee(req);
      const { count } = parse(RecapSlapsRequestSchema, req.body);
      state(ctx).limiter.enforce(`slap:${me.attendeeId}`, 'Your palm needs a rest.');
      const add = Math.min(count, 50);
      run(ctx.db, 'INSERT INTO recap_slaps (attendee_id, count) VALUES (?, ?) ON CONFLICT(attendee_id) DO UPDATE SET count = count + excluded.count', me.attendeeId, add);
      const total = one<{ count: number }>(ctx.db, 'SELECT count FROM recap_slaps WHERE attendee_id = ?', me.attendeeId)?.count ?? 0;
      if (total >= SLAP_HAPPY_AT) ctx.stickers.unlock(me.attendeeId, RECAP_STICKERS.slaps);
      return { total };
    });

    // GET /api/recap/rarity: how many people hold each sticker (sticker book badges). Cached 5 s.
    app.get('/rarity', async (req): Promise<StickerRarity> => {
      if (!getAttendee(req) && !isScreen(req)) throw unauthorized();
      return stickerRarity(ctx);
    });

    // GET /api/recap/room: the room's afternoon, for the projector and the console. Cached 5 s.
    app.get('/room', async (req): Promise<RoomRecap> => {
      requireScreen(req);
      return roomRecap(ctx);
    });

    // POST /api/recap/admin/open { open }
    app.post('/admin/open', async (req): Promise<RecapStatus> => {
      requireAdmin(req);
      const { open } = parse(RecapOpenRequestSchema, req.body);
      const st = setRecapOpen(ctx, open);
      invalidateRecap(ctx);
      publishStatus(ctx, st);
      return st;
    });

    // GET /api/recap/admin/attendees?q=  pick someone to preview (nickname, kit id or name)
    app.get('/admin/attendees', async (req): Promise<RecapAttendeeList> => {
      requireAdmin(req);
      const { q } = parse(RecapAttendeeQuerySchema, req.query ?? {});
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const rows = all<{ id: number; kit_id: string; nickname: string | null; total: number }>(
        ctx.db,
        `SELECT a.id, a.kit_id, a.nickname, COALESCE((SELECT SUM(points) FROM points_ledger l WHERE l.attendee_id = a.id), 0) AS total
           FROM attendees a
          WHERE a.nickname LIKE ? OR a.kit_id LIKE ? OR a.name LIKE ?
          ORDER BY total DESC, a.id ASC LIMIT 20`,
        like,
        like,
        like,
      );
      return { attendees: rows.map((r) => ({ id: r.id, kitId: r.kit_id, nickname: r.nickname, total: r.total })) };
    });

    // GET /api/recap/admin/attendee/:id  anyone's recap, open or not (console preview)
    app.get('/admin/attendee/:id', async (req): Promise<Recap> => {
      requireAdmin(req);
      const { id } = parse(IdParam, req.params);
      const r = buildRecap(ctx, id);
      if (!r) throw notFound('No such attendee.');
      return r;
    });
  },

  tick: { everyMs: 2000, run: tick },
});
