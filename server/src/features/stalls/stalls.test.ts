import { MAX_IMAGE_BYTES, mocktailProgress } from '@afterhours/shared/features/stalls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Jar, type TestApp, Jar as JarClass, adminJar, capture, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { ensureMocktailBar } from './admin';
import { parseCsv } from './csv';
import { makeCode, makeTicket, makeToken } from './tokens';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let key = 0;
const nextKey = () => `key-${String(++key).padStart(6, '0')}-abcdef`;

describe('stalls', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    // every test builds its own stalls: drop the mocktail bar a fresh database boots with
    t.ctx.db.exec('DELETE FROM stalls_item; DELETE FROM stalls_stall;');
  });
  afterEach(async () => t.close());

  const post = async (jar: Jar | null, url: string, body?: unknown) => req(t.app, jar, 'POST', url, body ?? {});
  const get = async (jar: Jar | null, url: string) => req(t.app, jar, 'GET', url);

  async function mkStall(name: string): Promise<{ id: number; code: string }> {
    const r = await post(admin, '/api/stalls/admin/stalls', { name, emoji: '\u{1F379}', location: 'x' });
    expect(r.statusCode).toBe(200);
    const id = (r.json() as { id: number }).id;
    const ov = (await get(admin, '/api/stalls/admin/overview')).json() as J;
    return { id, code: ov.stalls.find((s: J) => s.id === id).code };
  }
  async function mkItem(stallId: number, o: Record<string, unknown> = {}): Promise<number> {
    const r = await post(admin, '/api/stalls/admin/items', { stallId, name: 'thing', price: 10, ...o });
    expect(r.statusCode).toBe(200);
    return (r.json() as { id: number }).id;
  }
  async function shopJar(code: string): Promise<Jar> {
    const jar = new JarClass();
    const r = await post(jar, '/api/stalls/shop/signin', { code });
    expect(r.statusCode).toBe(200);
    return jar;
  }
  async function person(nickname: string, points = 0) {
    const [kit] = await makeKits(t.app, 1);
    const a = await signedInAttendee(t.app, kit!, nickname);
    // start from a known balance: drop the points sign-in and profile already paid
    t.ctx.db.prepare('DELETE FROM points_ledger WHERE attendee_id = ?').run(a.id);
    if (points) t.ctx.points.award({ attendeeId: a.id, source: 'test', ref: `seed-${a.id}`, points });
    return a;
  }
  const qr = async (a: { jar: Jar }) => (await get(a.jar, '/api/stalls/qr')).json() as J;
  const scan = async (shop: Jar, input: string) => post(shop, '/api/stalls/shop/scan', { input });
  async function hand(shop: Jar, a: { jar: Jar }, lines: { itemId: number; qty: number }[], k = nextKey()) {
    const s = await scan(shop, (await qr(a)).token);
    expect(s.statusCode).toBe(200);
    return post(shop, '/api/stalls/shop/commit', { ticket: (s.json() as J).ticket, key: k, lines });
  }
  const wallet = async (a: { jar: Jar }) => (await get(a.jar, '/api/stalls/wallet')).json() as J;

  it('balance is earned minus spent, and spending leaves the leaderboard alone', async () => {
    const st = await mkStall('Snacks');
    const item = await mkItem(st.id, { price: 20 });
    const a = await person('anna', 50);
    const b = await person('bala', 30);
    const shop = await shopJar(st.code);
    expect((await wallet(a)).balance).toBe(50);
    const r = await hand(shop, a, [{ itemId: item, qty: 2 }]);
    expect(r.statusCode).toBe(200);
    expect((r.json() as J).balance).toBe(10);
    const w = await wallet(a);
    expect([w.earned, w.spent, w.balance]).toEqual([50, 40, 10]);
    const lb = t.ctx.points.leaderboard(10, a.id);
    expect(lb.entries.map((e) => [e.nickname, e.total])).toEqual([['anna', 50], ['bala', 30]]);
    expect(lb.me?.rank).toBe(1);
    expect(b.id).not.toBe(a.id);
    // can't spend what you don't have
    const poor = await hand(shop, a, [{ itemId: item, qty: 1 }]);
    expect(poor.statusCode).toBe(409);
    expect((poor.json() as J).error.message).toMatch(/10 points short/);
    expect((await wallet(a)).balance).toBe(10);
  });

  it('settings: allowance defaults to 2, spendLowersBoard defaults off, both editable', async () => {
    const s = (await get(admin, '/api/stalls/admin/settings')).json() as J;
    expect(s).toEqual({ allowance: 2, spendLowersBoard: false });
    const r = await req(t.app, admin, 'PATCH', '/api/stalls/admin/settings', { allowance: 3, spendLowersBoard: true });
    expect(r.json()).toEqual({ allowance: 3, spendLowersBoard: true });
    expect((await req(t.app, admin, 'PATCH', '/api/stalls/admin/settings', { allowance: 99 })).statusCode).toBe(400);
    expect((await req(t.app, null, 'PATCH', '/api/stalls/admin/settings', { allowance: 1 })).statusCode).toBe(401);
  });

  it('free mocktails: 2 free, the 3rd is refused at price 0 and falls back to points when priced', async () => {
    const st = await mkStall('Bar');
    const welcome = await mkItem(st.id, { name: 'welcome drink', price: 0, freeDrink: true });
    const paid = await mkItem(st.id, { name: 'mocktail', price: 15, freeDrink: true });
    const a = await person('anna', 20);
    const shop = await shopJar(st.code);
    const cap = capture(t.ctx, { attendeeId: a.id, admin: false, screen: false });

    const r1 = await hand(shop, a, [{ itemId: welcome, qty: 1 }]);
    expect((r1.json() as J).freeLeft).toBe(1);
    const r2 = await hand(shop, a, [{ itemId: welcome, qty: 1 }]);
    expect((r2.json() as J).freeLeft).toBe(0);
    const r3 = await hand(shop, a, [{ itemId: welcome, qty: 1 }]);
    expect(r3.statusCode).toBe(409);
    expect((r3.json() as J).error.message).toMatch(/No free drinks left/);
    // priced: costs points now
    const r4 = await hand(shop, a, [{ itemId: paid, qty: 1 }]);
    expect(r4.statusCode).toBe(200);
    expect((r4.json() as J).pointsSpent).toBe(15);
    expect((r4.json() as J).balance).toBe(5);
    const w = await wallet(a);
    expect(w.allowance).toEqual({ total: 2, used: 2, left: 0 });
    expect(w.receipts).toHaveLength(3);
    expect(cap.types().filter((x) => x === 'stalls.redeemed')).toHaveLength(3);
    cap.unsub();
  });

  it('a fresh database boots with the mocktail bar: one mocktail, free allowance first, then 50 points', async () => {
    const fresh = await makeApp();
    try {
      const jar = await adminJar(fresh.app);
      const ov = (await req(fresh.app, jar, 'GET', '/api/stalls/admin/overview')).json() as J;
      expect(ov.stalls).toHaveLength(1);
      expect(ov.stalls[0]).toMatchObject({ name: 'mocktail bar', active: true });
      expect(ov.stalls[0].items).toEqual([expect.objectContaining({ name: 'mocktail', price: 50, freeDrink: true, stock: null, limit: null })]);
      expect(ov.settings.allowance).toBe(2);
      // deleting it sticks: boot never brings it back
      expect((await req(fresh.app, jar, 'DELETE', `/api/stalls/admin/stalls/${ov.stalls[0].id}`)).statusCode).toBe(200);
      ensureMocktailBar(fresh.ctx);
      expect(((await req(fresh.app, jar, 'GET', '/api/stalls/admin/overview')).json() as J).stalls).toHaveLength(0);
    } finally {
      await fresh.close();
    }
  });

  it('progress to the next mocktail: what your points buy and how far to the next', () => {
    expect(mocktailProgress(12, 50)).toEqual({ affordable: 0, toNext: 38, fraction: 0.24 });
    expect(mocktailProgress(0, 50)).toEqual({ affordable: 0, toNext: 50, fraction: 0 });
    expect(mocktailProgress(50, 50)).toEqual({ affordable: 1, toNext: 50, fraction: 0 });
    expect(mocktailProgress(137, 50)).toEqual({ affordable: 2, toNext: 13, fraction: 0.74 });
    expect(mocktailProgress(-5, 50)).toEqual({ affordable: 0, toNext: 50, fraction: 0 });
    expect(mocktailProgress(100, 0)).toEqual({ affordable: 0, toNext: 0, fraction: 0 });
  });

  it('wallet: the cheapest priced mocktail drives the progress bar', async () => {
    const st = await mkStall('Bar');
    await mkItem(st.id, { name: 'fancy mocktail', price: 80, freeDrink: true });
    await mkItem(st.id, { name: 'mocktail', price: 50, freeDrink: true });
    await mkItem(st.id, { name: 'tee', price: 20 });
    const a = await person('anna', 12);
    const w = await wallet(a);
    expect(w.nextMocktail).toEqual({ name: 'mocktail', price: 50, stallName: 'Bar' });
    expect(mocktailProgress(w.balance, w.nextMocktail.price).toNext).toBe(38);
  });

  it('a mixed line uses what is left of the allowance, then points', async () => {
    const st = await mkStall('Bar');
    const m = await mkItem(st.id, { name: 'mocktail', price: 10, freeDrink: true });
    const a = await person('anna', 100);
    const shop = await shopJar(st.code);
    const r = await hand(shop, a, [{ itemId: m, qty: 3 }]);
    const j = r.json() as J;
    expect([j.freeUsed, j.pointsSpent, j.freeLeft, j.balance]).toEqual([2, 10, 0, 90]);
  });

  it('two stalls scanning the same person at once never give out a third free drink', async () => {
    const s1 = await mkStall('Bar 1');
    const s2 = await mkStall('Bar 2');
    const i1 = await mkItem(s1.id, { price: 0, freeDrink: true });
    const i2 = await mkItem(s2.id, { price: 0, freeDrink: true });
    const a = await person('anna');
    const shops = [await shopJar(s1.code), await shopJar(s2.code)];
    const items = [i1, i2];
    const { token } = await qr(a);
    // each stall scans, then all four commits race
    const tickets: string[][] = [[], []];
    for (let s = 0; s < 2; s++) tickets[s]!.push(((await scan(shops[s]!, token)).json() as J).ticket);
    const attempts = [0, 1].flatMap((s) => [0, 1].map((n) => post(shops[s]!, '/api/stalls/shop/commit', { ticket: tickets[s]![0], key: nextKey() + `-${s}${n}`, lines: [{ itemId: items[s]!, qty: 1 }] })));
    const codes = (await Promise.all(attempts)).map((r) => r.statusCode);
    // a ticket is single-use, so each stall gets one through; the allowance holds regardless
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect((await wallet(a)).allowance.used).toBe(2);
    // and many more tries on fresh scans never pass 2
    for (let i = 0; i < 4; i++) await hand(shops[i % 2]!, a, [{ itemId: items[i % 2]!, qty: 1 }]);
    expect((await wallet(a)).allowance.used).toBe(2);
  });

  it('four stalls with fresh scans racing for one free drink each: exactly 2 go through', async () => {
    const shops: Jar[] = [];
    const items: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await mkStall(`Bar ${i}`);
      items.push(await mkItem(s.id, { price: 0, freeDrink: true }));
      shops.push(await shopJar(s.code));
    }
    const a = await person('anna');
    const { token } = await qr(a);
    const tickets: string[] = [];
    for (let i = 0; i < 4; i++) tickets.push(((await scan(shops[i]!, token)).json() as J).ticket);
    const rs = await Promise.all(tickets.map((ticket, i) => post(shops[i]!, '/api/stalls/shop/commit', { ticket, key: nextKey(), lines: [{ itemId: items[i]!, qty: 1 }] })));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(2);
    expect((await wallet(a)).allowance).toEqual({ total: 2, used: 2, left: 0 });
  });

  it('danger zone reset wipes purchases but keeps stalls, menus and earned points', async () => {
    const st = await mkStall('Bar');
    const m = await mkItem(st.id, { price: 10, freeDrink: true, stock: 5 });
    const a = await person('anna', 40);
    const shop = await shopJar(st.code);
    expect((await hand(shop, a, [{ itemId: m, qty: 3 }])).statusCode).toBe(200);
    expect((await post(admin, '/api/stalls/admin/reset', { confirm: 'nope' })).statusCode).toBe(400);
    expect((await post(null, '/api/stalls/admin/reset', { confirm: 'RESET STALLS' })).statusCode).toBe(401);
    expect((await post(admin, '/api/stalls/admin/reset', { confirm: 'RESET STALLS' })).statusCode).toBe(200);
    const w = await wallet(a);
    expect([w.earned, w.spent, w.balance, w.allowance.left, w.receipts.length]).toEqual([40, 0, 40, 2, 0]);
    const ov = (await get(admin, '/api/stalls/admin/overview')).json() as J;
    expect(ov.stalls[0].items[0]).toMatchObject({ stockLeft: 5, sold: 0 });
  });

  it('enforces stock and per-person limits', async () => {
    const st = await mkStall('Snacks');
    const scarce = await mkItem(st.id, { name: 'brownie', price: 1, stock: 3, limit: 2 });
    const a = await person('anna', 50);
    const b = await person('bala', 50);
    const c = await person('chitra', 50);
    const shop = await shopJar(st.code);
    expect((await hand(shop, a, [{ itemId: scarce, qty: 3 }])).statusCode).toBe(409); // over the limit of 2
    expect((await hand(shop, a, [{ itemId: scarce, qty: 2 }])).statusCode).toBe(200);
    expect((await hand(shop, a, [{ itemId: scarce, qty: 1 }])).statusCode).toBe(409); // limit reached
    expect((await hand(shop, b, [{ itemId: scarce, qty: 2 }])).statusCode).toBe(409); // only 1 left
    expect((await hand(shop, b, [{ itemId: scarce, qty: 1 }])).statusCode).toBe(200);
    const sold = await hand(shop, c, [{ itemId: scarce, qty: 1 }]);
    expect(sold.statusCode).toBe(409);
    expect((sold.json() as J).error.message).toMatch(/sold out/);
    const menu = (await get(c.jar, '/api/stalls/menu')).json() as J;
    expect(menu.stalls[0].items[0]).toMatchObject({ stockLeft: 0, limit: 2, bought: 0 });
  });

  it('is idempotent: the same key commits once, even raced', async () => {
    const st = await mkStall('Snacks');
    const item = await mkItem(st.id, { price: 10 });
    const a = await person('anna', 100);
    const shop = await shopJar(st.code);
    const { ticket } = (await scan(shop, (await qr(a)).token)).json() as J;
    const k = nextKey();
    const body = { ticket, key: k, lines: [{ itemId: item, qty: 1 }] };
    const rs = await Promise.all([post(shop, '/api/stalls/shop/commit', body), post(shop, '/api/stalls/shop/commit', body), post(shop, '/api/stalls/shop/commit', body)]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(rs.filter((r) => (r.json() as J).duplicate === false)).toHaveLength(1);
    expect(new Set(rs.map((r) => (r.json() as J).txnId)).size).toBe(1);
    expect((await wallet(a)).spent).toBe(10);
    // the same ticket with a new key does not buy twice
    const again = await post(shop, '/api/stalls/shop/commit', { ...body, key: nextKey() });
    expect(again.statusCode).toBe(409);
    expect((again.json() as J).error.code).toBe('ticket_used');
    // someone else cannot reuse the key
    const b = await person('bala', 100);
    const sb = (await scan(shop, (await qr(b)).token)).json() as J;
    expect((await post(shop, '/api/stalls/shop/commit', { ticket: sb.ticket, key: k, lines: body.lines })).statusCode).toBe(409);
    expect((await wallet(b)).spent).toBe(0);
  });

  it('QR tokens rotate, expire after the previous window, and cannot be forged', async () => {
    const st = await mkStall('Snacks');
    const a = await person('anna');
    const b = await person('bala');
    const shop = await shopJar(st.code);
    const first = await qr(a);
    expect(first.url).toContain('/stall/r/');
    expect(first.url.endsWith(first.token)).toBe(true);
    t.clock.set(Math.floor(t.clock.now() / 30_000) * 30_000 + 1_000); // 1 s into a window
    const tok = (await qr(a)).token;
    expect((await scan(shop, tok)).statusCode).toBe(200);
    t.clock.advance(30_000); // next window: the previous one still counts
    expect((await scan(shop, tok)).statusCode).toBe(200);
    expect((await qr(a)).token).not.toBe(tok);
    t.clock.advance(30_000); // two windows on: dead
    const dead = await scan(shop, tok);
    expect(dead.statusCode).toBe(400);
    expect((dead.json() as J).error.code).toBe('bad_token');
    // the full URL works too
    expect((await scan(shop, (await qr(a)).url)).statusCode).toBe(200);
    // forgery: swap the attendee, flip a signature char, make one up
    const live = (await qr(a)).token.split('.');
    const forged = [b.id.toString(36), live[1], live[2]].join('.');
    expect((await scan(shop, forged)).statusCode).toBe(400);
    const flipped = [live[0], live[1], (live[2]!.startsWith('A') ? 'B' : 'A') + live[2]!.slice(1)].join('.');
    expect((await scan(shop, flipped)).statusCode).toBe(400);
    expect((await scan(shop, 'abc.def.ghijklmnopqrstuv')).statusCode).toBe(400);
    // a future window is not accepted either
    const future = [live[0], (parseInt(live[1]!, 36) + 1).toString(36), live[2]].join('.');
    expect((await scan(shop, future)).statusCode).toBe(400);
  });

  it('the typed code works for the right person only, and rotates', async () => {
    const st = await mkStall('Snacks');
    const a = await person('anna');
    const shop = await shopJar(st.code);
    const { code } = await qr(a);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    const ok = await scan(shop, code.toLowerCase());
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as J).attendee.nickname).toBe('anna');
    expect((await scan(shop, 'ZZZZZZ')).statusCode).toBe(400);
    t.clock.advance(61_000);
    expect((await scan(shop, code)).statusCode).toBe(400);
    expect(makeCode(t.ctx, a.id, t.clock.now())).not.toBe(code);
  });

  it('a stall can only redeem at its own stall', async () => {
    const s1 = await mkStall('Bar');
    const s2 = await mkStall('Merch');
    const i1 = await mkItem(s1.id, { price: 1 });
    const i2 = await mkItem(s2.id, { price: 1 });
    const a = await person('anna', 20);
    const shop1 = await shopJar(s1.code);
    const shop2 = await shopJar(s2.code);
    const { ticket } = (await scan(shop1, (await qr(a)).token)).json() as J;
    // someone else's menu
    const wrongItem = await post(shop1, '/api/stalls/shop/commit', { ticket, key: nextKey(), lines: [{ itemId: i2, qty: 1 }] });
    expect(wrongItem.statusCode).toBe(409);
    // another stall's ticket
    const wrongTicket = await post(shop2, '/api/stalls/shop/commit', { ticket, key: nextKey(), lines: [{ itemId: i2, qty: 1 }] });
    expect(wrongTicket.statusCode).toBe(400);
    // the scan only shows this stall's menu
    const sc = (await scan(shop2, (await qr(a)).token)).json() as J;
    expect(sc.menu.map((m: J) => m.id)).toEqual([i2]);
    expect((await wallet(a)).spent).toBe(0);
    expect(i1).toBeGreaterThan(0);
    // not signed in, or a made-up cookie
    expect((await post(null, '/api/stalls/shop/scan', { input: 'x.y.z' })).statusCode).toBe(401);
    const fake = new JarClass();
    fake.cookies['ah_stall'] = 'nope';
    expect((await post(fake, '/api/stalls/shop/scan', { input: 'x.y.z' })).statusCode).toBe(401);
    // a ticket never works with a tampered stall id
    const t2 = makeTicket(t.ctx, a.id, s2.id, t.clock.now()).ticket.split('.');
    t2[1] = s1.id.toString(36);
    expect((await post(shop1, '/api/stalls/shop/commit', { ticket: t2.join('.'), key: nextKey(), lines: [{ itemId: i1, qty: 1 }] })).statusCode).toBe(400);
  });

  it('tickets expire', async () => {
    const st = await mkStall('Snacks');
    const item = await mkItem(st.id, { price: 1 });
    const a = await person('anna', 5);
    const shop = await shopJar(st.code);
    const { ticket } = (await scan(shop, (await qr(a)).token)).json() as J;
    t.clock.advance(6 * 60_000);
    expect((await post(shop, '/api/stalls/shop/commit', { ticket, key: nextKey(), lines: [{ itemId: item, qty: 1 }] })).statusCode).toBe(400);
  });

  it('only shows a stall what it needs about a person', async () => {
    const st = await mkStall('Snacks');
    await mkItem(st.id, { price: 1 });
    const a = await person('anna', 5);
    const shop = await shopJar(st.code);
    const sc = (await scan(shop, (await qr(a)).token)).json() as J;
    expect(Object.keys(sc).sort()).toEqual(['allowance', 'attendee', 'balance', 'cart', 'menu', 'puzzle', 'ticket', 'ticketExpiresAt']);
    expect(Object.keys(sc.attendee).sort()).toEqual(['avatar', 'nickname']);
    expect(JSON.stringify(sc)).not.toMatch(/kit|roll|AH-/i);
  });

  it('the basket follows the QR: the shopkeeper sees it pre-filled, only for their stall', async () => {
    const s1 = await mkStall('Bar');
    const s2 = await mkStall('Merch');
    const i1 = await mkItem(s1.id, { price: 1 });
    const i2 = await mkItem(s2.id, { price: 1 });
    const a = await person('anna', 20);
    const put = await req(t.app, a.jar, 'PUT', '/api/stalls/cart', { lines: [{ itemId: i1, qty: 2 }, { itemId: i2, qty: 1 }, { itemId: 99999, qty: 1 }] });
    expect((put.json() as J).lines).toHaveLength(2); // the unknown item is dropped
    const shop = await shopJar(s1.code);
    const sc = (await scan(shop, (await qr(a)).token)).json() as J;
    expect(sc.cart).toEqual([{ itemId: i1, qty: 2 }]);
    await post(shop, '/api/stalls/shop/commit', { ticket: sc.ticket, key: nextKey(), lines: sc.cart });
    expect(((await get(a.jar, '/api/stalls/cart')).json() as J).lines).toEqual([{ itemId: i2, qty: 1 }]); // the other stall's stays
  });

  it('void restores points, free drinks and stock; organiser only', async () => {
    const st = await mkStall('Bar');
    const m = await mkItem(st.id, { name: 'mocktail', price: 10, stock: 2, limit: 3, freeDrink: true });
    const a = await person('anna', 30);
    const shop = await shopJar(st.code);
    const r = await hand(shop, a, [{ itemId: m, qty: 3 }]);
    expect(r.statusCode).toBe(409); // stock 2
    const ok = await hand(shop, a, [{ itemId: m, qty: 2 }]);
    const txnId = (ok.json() as J).txnId;
    let w = await wallet(a);
    expect([w.balance, w.allowance.left]).toEqual([30, 0]);
    const noAuth = await post(shop, `/api/stalls/admin/txns/${txnId}/void`);
    expect(noAuth.statusCode).toBe(401);
    const cap = capture(t.ctx, { attendeeId: a.id, admin: false, screen: false });
    expect((await post(admin, `/api/stalls/admin/txns/${txnId}/void`, { reason: 'wrong drink' })).statusCode).toBe(200);
    expect(cap.types()).toContain('stalls.voided');
    cap.unsub();
    expect((await post(admin, `/api/stalls/admin/txns/${txnId}/void`)).statusCode).toBe(409);
    w = await wallet(a);
    expect([w.balance, w.allowance.left, w.spent]).toEqual([30, 2, 0]);
    expect(w.receipts[0].status).toBe('void');
    const ov = (await get(admin, '/api/stalls/admin/overview')).json() as J;
    expect(ov.stalls[0].items[0]).toMatchObject({ stockLeft: 2, sold: 0 });
    // and the stock is genuinely sellable again
    expect((await hand(shop, a, [{ itemId: m, qty: 2 }])).statusCode).toBe(200);
  });

  it('imports a pasted menu CSV, updates on a second run, reports bad rows', async () => {
    const csv = ['stall,item,price,stock,limit', 'Bar,Mocktail,15,,2', '"Bar","Cold, coffee",10,50,', 'Merch,Tee,120,12,1', 'Merch,Broken,abc,,', ',nameless,1,,', 'Merch,Hat,5,x,'].join('\n');
    const r = await post(admin, '/api/stalls/admin/import', { csv });
    const j = r.json() as J;
    expect([j.stallsCreated, j.itemsCreated, j.itemsUpdated]).toEqual([2, 3, 0]);
    expect(j.errors.map((e: J) => e.line)).toEqual([5, 6, 7]);
    const again = (await post(admin, '/api/stalls/admin/import', { csv: 'bar,mocktail,20,5,1\n' })).json() as J;
    expect([again.stallsCreated, again.itemsCreated, again.itemsUpdated]).toEqual([0, 0, 1]);
    const ov = (await get(admin, '/api/stalls/admin/overview')).json() as J;
    expect(ov.stalls).toHaveLength(2);
    const mock = ov.stalls[0].items.find((i: J) => i.name === 'Mocktail');
    expect(mock).toMatchObject({ price: 20, stock: 5, limit: 1 });
    expect(ov.stalls[0].items.map((i: J) => i.name)).toContain('Cold, coffee');
    expect(ov.stalls[0].code).toMatch(/^\d{6}$/);
    // tab separated (pasted from a spreadsheet) works
    expect(parseCsv('a\tb\tc\n1\t2\t3').map((x) => x.cells)).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect((await post(null, '/api/stalls/admin/import', { csv })).statusCode).toBe(401);
  });

  it('item images: 300 KB cap, real image types only', async () => {
    const st = await mkStall('Bar');
    const item = await mkItem(st.id);
    const url = `/api/stalls/admin/items/${item}/image`;
    const ok = await post(admin, url, { data: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(ok.statusCode).toBe(200);
    const path = (ok.json() as { image: string }).image;
    const served = await get(null, path);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(Buffer.from(served.rawPayload).equals(PNG)).toBe(true);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const tooBig = await post(admin, url, { data: big.toString('base64') });
    expect(tooBig.statusCode).toBe(413);
    const svg = await post(admin, url, { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') });
    expect(svg.statusCode).toBe(400);
    expect((await post(null, url, { data: PNG.toString('base64') })).statusCode).toBe(401);
    expect((await get(null, '/api/stalls/img/..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
    // the item still shows its picture; deleting the image clears it
    const menu = (await get((await person('anna')).jar, '/api/stalls/menu')).json() as J;
    expect(menu.stalls[0].items[0].image).toBe(path);
    expect((await req(t.app, admin, 'DELETE', url)).statusCode).toBe(200);
  });

  it('stall codes: sign in, wrong code, rotate signs the old shopkeeper out', async () => {
    const st = await mkStall('Bar');
    expect((await post(new JarClass(), '/api/stalls/shop/signin', { code: '000000' })).statusCode).toBe(401);
    const shop = await shopJar(st.code);
    expect((await get(shop, '/api/stalls/shop/me')).statusCode).toBe(200);
    const rot = await post(admin, `/api/stalls/admin/stalls/${st.id}/rotate`);
    const fresh = (rot.json() as { code: string }).code;
    expect(fresh).not.toBe(st.code);
    expect((await get(shop, '/api/stalls/shop/me')).statusCode).toBe(401);
    expect((await post(new JarClass(), '/api/stalls/shop/signin', { code: st.code })).statusCode).toBe(401);
    const again = await shopJar(fresh);
    expect((await get(again, '/api/stalls/shop/me')).statusCode).toBe(200);
    // closing a stall locks it too
    await req(t.app, admin, 'PATCH', `/api/stalls/admin/stalls/${st.id}`, { active: false });
    expect((await get(again, '/api/stalls/shop/me')).statusCode).toBe(401);
  });

  it('rate limits scans per stall and sign-in tries per phone', async () => {
    const st = await mkStall('Bar');
    const shop = await shopJar(st.code);
    let limited = 0;
    for (let i = 0; i < 45; i++) if ((await scan(shop, 'x.y.z')).statusCode === 429) limited++;
    expect(limited).toBe(5);
    const bad = new JarClass();
    let blocked = 0;
    for (let i = 0; i < 14; i++) if ((await post(bad, '/api/stalls/shop/signin', { code: '123456' })).statusCode === 429) blocked++;
    expect(blocked).toBeGreaterThan(0);
  });

  it('tally, transactions list and CSV export', async () => {
    const st = await mkStall('Bar');
    const m = await mkItem(st.id, { name: 'mocktail', price: 0, freeDrink: true });
    const t2 = await mkItem(st.id, { name: 'tee, "xl"', price: 5 });
    const a = await person('-anna', 20);
    const shop = await shopJar(st.code);
    await hand(shop, a, [{ itemId: m, qty: 1 }, { itemId: t2, qty: 2 }]);
    const me = (await get(shop, '/api/stalls/shop/me')).json() as J;
    expect(me.tally).toMatchObject({ txns: 1, units: 3, freeUnits: 1, points: 10 });
    const txns = (await get(admin, '/api/stalls/admin/txns')).json() as J;
    expect(txns.txns[0]).toMatchObject({ stallName: 'Bar', totalPoints: 10, freeUsed: 1, status: 'ok' });
    const csv = await get(admin, '/api/stalls/admin/export.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split(/\r\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('2 x tee, ""xl""');
    expect(lines[1]).toContain("'-anna"); // spreadsheet formulas are defused
    expect((await get(shop, '/api/stalls/admin/export.csv')).statusCode).toBe(401);
  });

  it('puzzle tokens show read-only and are never mixed with free mocktails', async () => {
    const st = await mkStall('Bar');
    const m = await mkItem(st.id, { price: 0, freeDrink: true });
    const a = await person('anna');
    const w = await wallet(a);
    expect(w.puzzle).toEqual({ tokens: 0, cost: 3 });
    const shop = await shopJar(st.code);
    await hand(shop, a, [{ itemId: m, qty: 2 }]);
    expect((await wallet(a)).puzzle).toEqual({ tokens: 0, cost: 3 });
    expect((await wallet(a)).allowance.left).toBe(0);
  });

  it('300 attendees redeeming in a burst: nothing oversold, nobody double-charged', async () => {
    const N = 300;
    const stallsN = 10;
    const stallList: { id: number; code: string; item: number }[] = [];
    for (let i = 0; i < stallsN; i++) {
      const s = await mkStall(`Stall ${i}`);
      stallList.push({ ...s, item: await mkItem(s.id, { name: 'mocktail', price: 5, freeDrink: true, stock: 20 }) });
    }
    const shops = await Promise.all(stallList.map((s) => shopJar(s.code)));
    // attendees straight into the database: this test is about the stalls, not about scrypt
    const ids: number[] = [];
    t.ctx.db.exec('BEGIN');
    for (let i = 0; i < N; i++) {
      const kit = `BX-${String(i).padStart(3, '0')}`;
      t.ctx.db.prepare("INSERT INTO kits (id, password_hash, created_at) VALUES (?, 'x', 0)").run(kit);
      const r = t.ctx.db
        .prepare("INSERT INTO attendees (kit_id, name, roll, nickname, avatar, profile_complete, first_signin_at) VALUES (?, 'n', 'r', ?, NULL, 1, 0)")
        .run(kit, `p${i}`);
      ids.push(Number(r.lastInsertRowid));
      t.ctx.points.award({ attendeeId: ids[i]!, source: 'test', ref: 'b', points: 10 });
    }
    t.ctx.db.exec('COMMIT');
    // person i queues at stall i % 10; each wants 3 mocktails: 2 free + 1 for 5 points
    const results = await Promise.all(
      ids.map(async (id, i) => {
        const s = i % stallsN;
        const sc = await scan(shops[s]!, makeToken(t.ctx, id, t.clock.now()));
        if (sc.statusCode !== 200) return sc.statusCode;
        const r = await post(shops[s]!, '/api/stalls/shop/commit', { ticket: (sc.json() as J).ticket, key: `burst-${id}-0000`, lines: [{ itemId: stallList[s]!.item, qty: 3 }] });
        return r.statusCode;
      }),
    );
    // stock is 20 per stall and each sale is 3: 6 sales per stall (18 units), the 7th is refused
    expect(results.filter((c) => c === 200)).toHaveLength(60);
    expect(results.filter((c) => c === 409)).toHaveLength(240);
    expect(results.filter((c) => c !== 200 && c !== 409)).toEqual([]);
    const ov = (await get(admin, '/api/stalls/admin/overview')).json() as J;
    for (const s of ov.stalls) expect(s.items[0].sold).toBeLessThanOrEqual(20);
    expect(ov.totals.txns).toBe(60);
    // every charged person was charged exactly once (5 points of 10)
    const spent = t.ctx.db.prepare("SELECT attendee_id, SUM(total_points) AS p, COUNT(*) AS n FROM stalls_txn WHERE status = 'ok' GROUP BY attendee_id").all() as { p: number; n: number }[];
    expect(spent).toHaveLength(60);
    expect(spent.every((r) => r.p === 5 && r.n === 1)).toBe(true);
    // a code lookup still works with 300 people
    const code = makeCode(t.ctx, ids[7]!, t.clock.now());
    expect((await scan(shops[0]!, code)).statusCode).toBe(200);
    expect(makeTicket(t.ctx, 1, 1, 0).ticket.length).toBeGreaterThan(10);
  });
});
