// Stalls and rewards: points spent at the food/merch stalls, free mocktails, and the shopkeeper's scan.
//
//   attendee   /api/stalls/{wallet,menu,cart,qr}        rotating signed QR, basket, receipts
//   shopkeeper /api/stalls/shop/*                       stall-code sign-in (cookie ah_stall), scan, commit
//   console    /api/stalls/admin/*                      stalls, items, images, CSV import, void, export
//
// Money rules live in service.ts and the shared planCart(); read ../../../../docs/EXTENDING.md for the shape.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ok } from '@afterhours/shared';
import {
  type AdminOverview,
  type AdminTxn,
  AdminTxnsSchema,
  type Cart,
  CartSchema,
  type CommitResponse,
  CommitRequestSchema,
  ImageUploadSchema,
  ImportRequestSchema,
  type ImportResult,
  ItemInputSchema,
  ItemPatchSchema,
  type MenuResponse,
  QR_WINDOW_MS,
  type QrResponse,
  RESET_CONFIRM,
  ResetRequestSchema,
  ScanRequestSchema,
  type ScanResponse,
  type ShopMe,
  ShopSignInRequestSchema,
  StallInputSchema,
  StallPatchSchema,
  StallSettingsPatchSchema,
  type StallSettings,
  VoidRequestSchema,
  type Wallet,
} from '@afterhours/shared/features/stalls';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type FeatureContext,
  HttpError,
  RateLimiter,
  badRequest,
  defineFeature,
  getPublicAttendee,
  notFound,
  one,
  parse,
  requireAdmin,
  requireAttendee,
  run,
  unauthorized,
} from '../../core';
import {
  createItem,
  createStall,
  ensureMocktailBar,
  exportCsv,
  importCsv,
  listTxns,
  overview,
  removeItem,
  removeStall,
  resetPurchases,
  rotateCode,
} from './admin';
import { deleteImage, readImage, saveImage } from './images';
import {
  activeStalls,
  allowanceOf,
  balanceOf,
  commit,
  getCart,
  getSettings,
  menuFor,
  nextMocktail,
  puzzleTokens,
  receiptsOf,
  setCart,
  setSettings,
  stallBrief,
  tallyOf,
  voidTxn,
} from './service';
import { extractToken, makeCode, makeTicket, makeToken, resolveCode, verifyTicket, verifyToken, windowOf } from './tokens';

export const STALL_COOKIE = 'ah_stall';

interface Limits {
  qr: RateLimiter;
  signin: RateLimiter;
  signinAll: RateLimiter;
  scan: RateLimiter;
  code: RateLimiter;
  commit: RateLimiter;
  /** tickets that already produced a purchase -> the key that did it */
  spent: Map<string, string>;
}
const limits = new WeakMap<FeatureContext, Limits>();
function limitsOf(ctx: FeatureContext): Limits {
  let l = limits.get(ctx);
  if (!l) {
    const now = ctx.now;
    l = {
      qr: new RateLimiter({ limit: 12, windowMs: 60_000, now }),
      signin: new RateLimiter({ limit: 10, windowMs: 60_000, now }),
      signinAll: new RateLimiter({ limit: 60, windowMs: 60_000, now }),
      // A busy counter is about one person every few seconds: 40 a minute per stall is plenty.
      scan: new RateLimiter({ limit: 40, windowMs: 60_000, now }),
      // Typed codes are the guessable path: much tighter.
      code: new RateLimiter({ limit: 12, windowMs: 60_000, now }),
      commit: new RateLimiter({ limit: 60, windowMs: 60_000, now }),
      spent: new Map(),
    };
    limits.set(ctx, l);
  }
  return l;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface ShopStall {
  id: number;
  name: string;
  emoji: string;
  location: string;
}

/** The stall this request is signed in as, or null. */
function shopStall(ctx: FeatureContext, req: FastifyRequest): ShopStall | null {
  const token = req.cookies[STALL_COOKIE];
  if (!token || token.length > 100) return null;
  return (
    one<ShopStall>(
      ctx.db,
      `SELECT s.id, s.name, s.emoji, s.location FROM stalls_session x JOIN stalls_stall s ON s.id = x.stall_id
        WHERE x.token_hash = ? AND x.expires_at > ? AND s.active = 1`,
      sha(token),
      ctx.now(),
    ) ?? null
  );
}

function requireShop(ctx: FeatureContext, req: FastifyRequest): ShopStall {
  const s = shopStall(ctx, req);
  if (!s) throw unauthorized('Sign in with your stall code.');
  return s;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const idParam = (req: FastifyRequest): number => {
  const n = Number((req.params as { id?: string }).id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Bad id.');
  return n;
};

/** Image uploads are base64 in JSON: up to ~400 KB, above core's 256 KB default body limit. */
const IMAGE_BODY_LIMIT = 520 * 1024;

export const stalls = defineFeature({
  name: 'stalls',

  routes(app, ctx) {
    const L = limitsOf(ctx);

    /* ============================================================ attendee */

    // GET /api/stalls/wallet
    app.get('/wallet', async (req): Promise<Wallet> => {
      const me = requireAttendee(req);
      const b = balanceOf(ctx, me.attendeeId);
      return { ...b, nextMocktail: nextMocktail(ctx), allowance: allowanceOf(ctx, me.attendeeId), puzzle: puzzleTokens(ctx, me.attendeeId), receipts: receiptsOf(ctx, me.attendeeId) };
    });

    // GET /api/stalls/menu: every open stall with its items, as this person sees them.
    app.get('/menu', async (req): Promise<MenuResponse> => {
      const me = requireAttendee(req);
      return { stalls: activeStalls(ctx).map((s) => ({ ...s, items: menuFor(ctx, s.id, me.attendeeId) })).filter((s) => s.items.length > 0) };
    });

    // GET/PUT /api/stalls/cart: the basket the shopkeeper sees pre-filled after a scan.
    app.get('/cart', async (req): Promise<Cart> => ({ lines: getCart(ctx, requireAttendee(req).attendeeId) }));
    app.put('/cart', async (req): Promise<Cart> => {
      const me = requireAttendee(req);
      const body = parse(CartSchema, req.body);
      return { lines: setCart(ctx, me.attendeeId, body.lines) };
    });

    // GET /api/stalls/qr: a fresh signed token + typed code for the current 30 s window.
    app.get('/qr', async (req): Promise<QrResponse> => {
      const me = requireAttendee(req);
      L.qr.enforce(`a:${me.attendeeId}`, 'Easy on the refresh. The code rotates by itself.');
      const now = ctx.now();
      const token = makeToken(ctx, me.attendeeId, now);
      return {
        token,
        code: makeCode(ctx, me.attendeeId, now),
        url: `${ctx.config.appUrl}/stall/r/${token}`,
        expiresAt: (windowOf(now) + 1) * QR_WINDOW_MS,
        windowMs: QR_WINDOW_MS,
        serverNow: now,
      };
    });

    // GET /api/stalls/img/:name: item photos. Names are random, so no sign-in needed (shop, console and phones all use it).
    app.get('/img/:name', async (req, reply) => {
      const img = readImage(ctx, String((req.params as { name: string }).name));
      if (!img) throw notFound('No such picture.');
      void reply.header('content-type', img.mime).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
      return reply.send(img.body);
    });

    /* ============================================================ shopkeeper */

    // POST /api/stalls/shop/signin { code }
    app.post('/shop/signin', async (req, reply): Promise<ShopMe> => {
      L.signin.enforce(`ip:${req.ip}`, 'Too many tries from this phone. Wait a moment.');
      L.signinAll.enforce('all', 'Lots of stall sign-in tries. Wait a moment.');
      const { code } = parse(ShopSignInRequestSchema, req.body);
      const clean = code.replace(/\s+/g, '');
      const stall = one<ShopStall & { code: string }>(ctx.db, 'SELECT id, name, emoji, location, code FROM stalls_stall WHERE active = 1 AND code = ?', clean);
      if (!stall || !safeEq(stall.code, clean)) throw unauthorized('That stall code is not right. Check the console.');
      const token = randomBytes(24).toString('base64url');
      const expires = ctx.now() + ctx.config.sessionHours * 3600_000;
      run(ctx.db, 'INSERT INTO stalls_session (token_hash, stall_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha(token), stall.id, ctx.now(), expires);
      void reply.setCookie(STALL_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure, expires: new Date(expires) });
      return { stall: stallBrief(stall), tally: tallyOf(ctx, stall.id) };
    });

    // POST /api/stalls/shop/signout
    app.post('/shop/signout', async (req, reply): Promise<Ok> => {
      const t = req.cookies[STALL_COOKIE];
      if (t) run(ctx.db, 'DELETE FROM stalls_session WHERE token_hash = ?', sha(t));
      void reply.clearCookie(STALL_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure });
      return { ok: true };
    });

    // GET /api/stalls/shop/me: who am I signed in as, and today's tally.
    app.get('/shop/me', async (req): Promise<ShopMe> => {
      const s = requireShop(ctx, req);
      return { stall: stallBrief(s), tally: tallyOf(ctx, s.id) };
    });

    // POST /api/stalls/shop/scan { input }: the QR token (or the whole /stall/r/ URL), or the typed code.
    app.post('/shop/scan', async (req): Promise<ScanResponse> => {
      const s = requireShop(ctx, req);
      L.scan.enforce(`s:${s.id}`, 'Scanning too fast. One person at a time.');
      const { input } = parse(ScanRequestSchema, req.body);
      const now = ctx.now();
      const raw = extractToken(input);
      let attendeeId: number | null;
      if (raw.includes('.')) attendeeId = verifyToken(ctx, raw, now);
      else {
        L.code.enforce(`s:${s.id}`, 'Too many typed codes. Scan the QR instead, or wait a moment.');
        attendeeId = resolveCode(ctx, raw, now);
      }
      if (attendeeId === null) throw new HttpError(400, 'bad_token', 'That code has expired or is not valid. Ask them to open "show my QR" again.');
      const who = getPublicAttendee(ctx, attendeeId);
      if (!who) throw new HttpError(400, 'bad_token', 'That person has not finished setting up their profile.');
      const menu = menuFor(ctx, s.id, attendeeId);
      const onMenu = new Set(menu.map((m) => m.id));
      const t = makeTicket(ctx, attendeeId, s.id, now);
      return {
        ticket: t.ticket,
        ticketExpiresAt: t.expiresAt,
        attendee: { nickname: who.nickname, avatar: who.avatar },
        allowance: allowanceOf(ctx, attendeeId),
        balance: balanceOf(ctx, attendeeId).balance,
        puzzle: puzzleTokens(ctx, attendeeId),
        cart: getCart(ctx, attendeeId).filter((c) => onMenu.has(c.itemId)),
        menu,
      };
    });

    // POST /api/stalls/shop/commit { ticket, key, lines }: hand it over. Atomic and idempotent on `key`.
    app.post('/shop/commit', async (req): Promise<CommitResponse> => {
      const s = requireShop(ctx, req);
      L.commit.enforce(`s:${s.id}`, 'Too many hand-overs a minute. Take a breath.');
      const body = parse(CommitRequestSchema, req.body);
      const t = verifyTicket(ctx, body.ticket, s.id, ctx.now());
      if (!t) throw new HttpError(400, 'bad_token', 'That scan has timed out. Scan their QR again.');
      const used = L.spent.get(body.ticket);
      if (used !== undefined && used !== body.key) throw new HttpError(409, 'ticket_used', 'Already handed over. Scan their QR again for another round.');
      const res = commit(ctx, { attendeeId: t.attendeeId, stallId: s.id, key: body.key, lines: body.lines });
      L.spent.set(body.ticket, body.key);
      if (L.spent.size > 5000) for (const k of [...L.spent.keys()].slice(0, 2500)) L.spent.delete(k);
      return res;
    });

    /* ============================================================ console */

    // GET /api/stalls/admin/overview
    app.get('/admin/overview', async (req): Promise<AdminOverview> => {
      requireAdmin(req);
      return overview(ctx);
    });

    // PATCH /api/stalls/admin/settings { allowance?, spendLowersBoard? }
    app.patch('/admin/settings', async (req): Promise<StallSettings> => {
      requireAdmin(req);
      return setSettings(ctx, parse(StallSettingsPatchSchema, req.body));
    });
    app.get('/admin/settings', async (req): Promise<StallSettings> => {
      requireAdmin(req);
      return getSettings(ctx);
    });

    // POST /api/stalls/admin/stalls, PATCH/DELETE /api/stalls/admin/stalls/:id, POST .../:id/rotate
    app.post('/admin/stalls', async (req): Promise<{ id: number }> => {
      requireAdmin(req);
      const b = parse(StallInputSchema, req.body);
      return { id: createStall(ctx, b) };
    });
    app.patch('/admin/stalls/:id', async (req): Promise<Ok> => {
      requireAdmin(req);
      const id = idParam(req);
      const b = parse(StallPatchSchema, req.body);
      if (!one(ctx.db, 'SELECT 1 AS x FROM stalls_stall WHERE id = ?', id)) throw notFound('No such stall.');
      run(
        ctx.db,
        'UPDATE stalls_stall SET name = COALESCE(?, name), emoji = COALESCE(?, emoji), location = COALESCE(?, location), active = COALESCE(?, active) WHERE id = ?',
        b.name ?? null,
        b.emoji ?? null,
        b.location ?? null,
        b.active === undefined ? null : b.active ? 1 : 0,
        id,
      );
      if (b.active === false) run(ctx.db, 'DELETE FROM stalls_session WHERE stall_id = ?', id);
      return { ok: true };
    });
    app.delete('/admin/stalls/:id', async (req): Promise<{ result: 'deleted' | 'closed' }> => {
      requireAdmin(req);
      return { result: removeStall(ctx, idParam(req)) };
    });
    app.post('/admin/stalls/:id/rotate', async (req): Promise<{ code: string }> => {
      requireAdmin(req);
      return { code: rotateCode(ctx, idParam(req)) };
    });

    // Items
    app.post('/admin/items', async (req): Promise<{ id: number }> => {
      requireAdmin(req);
      return { id: createItem(ctx, parse(ItemInputSchema, req.body)) };
    });
    app.patch('/admin/items/:id', async (req): Promise<Ok> => {
      requireAdmin(req);
      const id = idParam(req);
      const b = parse(ItemPatchSchema, req.body);
      if (!one(ctx.db, 'SELECT 1 AS x FROM stalls_item WHERE id = ?', id)) throw notFound('No such item.');
      // `stock` and `limit` use null as "unlimited", so they are applied only when present in the body.
      const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body as object, k);
      run(
        ctx.db,
        `UPDATE stalls_item SET name = COALESCE(?, name), price = COALESCE(?, price), free_drink = COALESCE(?, free_drink), active = COALESCE(?, active),
                stock = CASE WHEN ? THEN ? ELSE stock END, per_person = CASE WHEN ? THEN ? ELSE per_person END WHERE id = ?`,
        b.name ?? null,
        b.price ?? null,
        b.freeDrink === undefined ? null : b.freeDrink ? 1 : 0,
        b.active === undefined ? null : b.active ? 1 : 0,
        has('stock') ? 1 : 0,
        b.stock ?? null,
        has('limit') ? 1 : 0,
        b.limit ?? null,
        id,
      );
      return { ok: true };
    });
    app.delete('/admin/items/:id', async (req): Promise<{ result: 'deleted' | 'archived' }> => {
      requireAdmin(req);
      return { result: removeItem(ctx, idParam(req)) };
    });

    // POST /api/stalls/admin/items/:id/image { data: base64 | data URL }   (max 300 KB, PNG/JPEG/WebP/GIF)
    app.post('/admin/items/:id/image', { bodyLimit: IMAGE_BODY_LIMIT }, async (req): Promise<{ image: string }> => {
      requireAdmin(req);
      const id = idParam(req);
      const item = one<{ image: string | null }>(ctx.db, 'SELECT image FROM stalls_item WHERE id = ?', id);
      if (!item) throw notFound('No such item.');
      const { data } = parse(ImageUploadSchema, req.body);
      const name = saveImage(ctx, data);
      run(ctx.db, 'UPDATE stalls_item SET image = ? WHERE id = ?', name, id);
      deleteImage(ctx, item.image);
      return { image: `/api/stalls/img/${name}` };
    });
    app.delete('/admin/items/:id/image', async (req): Promise<Ok> => {
      requireAdmin(req);
      const id = idParam(req);
      const item = one<{ image: string | null }>(ctx.db, 'SELECT image FROM stalls_item WHERE id = ?', id);
      if (!item) throw notFound('No such item.');
      run(ctx.db, 'UPDATE stalls_item SET image = NULL WHERE id = ?', id);
      deleteImage(ctx, item.image);
      return { ok: true };
    });

    // POST /api/stalls/admin/import { csv }   stall,item,price,stock,limit
    app.post('/admin/import', async (req): Promise<ImportResult> => {
      requireAdmin(req);
      return importCsv(ctx, parse(ImportRequestSchema, req.body).csv);
    });

    // GET /api/stalls/admin/txns?stall=<id>
    app.get('/admin/txns', async (req): Promise<{ txns: AdminTxn[] }> => {
      requireAdmin(req);
      const q = req.query as { stall?: string };
      const stallId = q.stall ? Number(q.stall) : undefined;
      const out = { txns: listTxns(ctx, { stallId: stallId && Number.isInteger(stallId) ? stallId : undefined, limit: 200 }) };
      return AdminTxnsSchema.parse(out);
    });

    // POST /api/stalls/admin/txns/:id/void { reason? }: organiser only. Points, free drink and stock come back.
    app.post('/admin/txns/:id/void', async (req): Promise<Ok> => {
      requireAdmin(req);
      const { reason } = parse(VoidRequestSchema, req.body ?? {});
      voidTxn(ctx, idParam(req), reason ?? null);
      return { ok: true };
    });

    // GET /api/stalls/admin/export.csv
    app.get('/admin/export.csv', async (req, reply: FastifyReply) => {
      requireAdmin(req);
      void reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="stall-transactions.csv"');
      return exportCsv(ctx);
    });

    // POST /api/stalls/admin/reset { confirm: 'RESET STALLS' }: danger zone (after the dry run). Wipes every
    // purchase and basket; stalls, menus, codes and settings stay. Points earned are untouched.
    app.post('/admin/reset', async (req): Promise<Ok> => {
      requireAdmin(req);
      const { confirm } = parse(ResetRequestSchema, req.body);
      if (confirm !== RESET_CONFIRM) throw badRequest(`Type ${RESET_CONFIRM} to confirm.`);
      resetPurchases(ctx);
      L.spent.clear();
      return { ok: true };
    });

    // GET /api/stalls/admin/lookup?kit=AH-001: a person's wallet, for fixing things at the desk.
    app.get('/admin/lookup', async (req) => {
      requireAdmin(req);
      const kit = String((req.query as { kit?: string }).kit ?? '').trim().slice(0, 20);
      const a = one<{ id: number; nickname: string | null }>(ctx.db, 'SELECT id, nickname FROM attendees WHERE kit_id = ? COLLATE NOCASE', kit);
      if (!a) throw notFound(`No attendee has signed in with kit ${kit}.`);
      return { nickname: a.nickname ?? '', ...balanceOf(ctx, a.id), allowance: allowanceOf(ctx, a.id), receipts: receiptsOf(ctx, a.id) };
    });
  },

  // A fresh database comes with the mocktail bar ready: one stall, one "mocktail" item that uses the free
  // allowance first and then costs 50 points (editable). Only ever once, so deleting it in the console sticks.
  boot(ctx) {
    ensureMocktailBar(ctx);
  },

  seed(ctx) {
    if (one(ctx.db, "SELECT 1 AS x FROM stalls_stall WHERE name = 'Snack Shack'")) return;
    importCsv(
      ctx,
      [
        'stall,item,price,stock,limit,free',
        'Mocktail Bar,Mocktail,50,,,yes',
        'Mocktail Bar,Cold coffee,10,60,2,',
        'Mocktail Bar,Masala chai,5,,,',
        'Snack Shack,Samosa,8,100,3,',
        'Snack Shack,Brownie,12,40,2,',
        'Snack Shack,Chips,5,,,',
        'Merch Table,Recurse sticker pack,20,50,1,',
        'Merch Table,Recurse tee,120,12,1,',
      ].join('\n'),
    );
    const bar = one<{ id: number }>(ctx.db, "SELECT id FROM stalls_stall WHERE name = 'Mocktail Bar'");
    const snack = one<{ id: number }>(ctx.db, "SELECT id FROM stalls_stall WHERE name = 'Snack Shack'");
    const merch = one<{ id: number }>(ctx.db, "SELECT id FROM stalls_stall WHERE name = 'Merch Table'");
    for (const [s, emoji, loc] of [
      [bar, '\u{1F379}', 'by the stage'],
      [snack, '\u{1F37F}', 'courtyard'],
      [merch, 'doodle:star', 'registration desk'],
    ] as const) {
      if (s) run(ctx.db, 'UPDATE stalls_stall SET emoji = ?, location = ? WHERE id = ?', emoji, loc, s.id);
    }
  },
});
