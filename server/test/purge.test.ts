// "purge test player": a mock tester who played across features is removed with every trace, and the
// board, counts and stock look as if they never existed.
import type { PurgeReport } from '@afterhours/shared';
import type { HuntMe, MorseSlipSetup, SlipPrintSheet } from '@afterhours/shared/features/hunt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, one, run } from '../src/core/db';
import { setVisibility } from '../src/features/hunt/visibility';
import { AVATAR, Jar, type TestApp, adminJar, makeApp, makeKits, req, signedInAttendee } from './helpers';

type J = Record<string, unknown>;

describe('purge test player', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    setVisibility(t.ctx, { hunt: true, morse: true });
  });
  afterEach(async () => t.close());

  const totals = () => one<{ people: number; pts: number | null }>(t.ctx.db, 'SELECT COUNT(DISTINCT attendee_id) AS people, SUM(points) AS pts FROM points_ledger')!;
  const count = (table: string) => one<{ n: number }>(t.ctx.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;

  it('removes the tester and every trace; the board, stock and claims are as if they never came', async () => {
    // a real player, who stays
    const [kit] = await makeKits(t.app, 1);
    const real = await signedInAttendee(t.app, kit!, 'real');
    const morse = (await req(t.app, admin, 'POST', '/api/hunt/admin/morse-slip')).json() as MorseSlipSetup;
    const sheet = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-print?set=${morse.setId}`)).json() as SlipPrintSheet;
    const stopId = ((await req(t.app, admin, 'GET', `/api/hunt/admin?trail=${morse.trailId}`)).json() as { stops: { id: number }[] }).stops[0]!.id;
    await req(t.app, real.jar, 'POST', '/api/hunt/start', { trailId: morse.trailId });
    await req(t.app, real.jar, 'POST', '/api/hunt/slip', { stopId, text: sheet.slips[1]!.edges.left!.word });
    // a stall with stock 5
    const stall = run(t.ctx.db, "INSERT INTO stalls_stall (name, emoji, location, code, created_at) VALUES ('bar', 'x', 'here', '999111', 1)").lastId;
    const item = run(t.ctx.db, "INSERT INTO stalls_item (stall_id, name, price, stock) VALUES (?, 'mocktail', 10, 5)", stall).lastId;
    const before = { totals: totals(), stickers: count('sticker_unlocks'), attendees: count('attendees'), finds: count('hunt_slip_finds') };

    // the mock tester: a roster participant who signs in with their roll and plays
    const p = (await req(t.app, admin, 'POST', '/api/admin/participants', { name: 'Mock Tester', roll: '99BD1A90T1', phone: '9000000001', note: 'mock tester: remove before the event' })).json() as J;
    const jar = new Jar();
    expect((await req(t.app, jar, 'POST', '/api/auth/roll/signin', { roll: '99BD1A90T1', phone4: '0001' })).statusCode).toBe(200);
    const me = (await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Mock Tester', roll: '99BD1A90T1', nickname: 'mock', avatar: AVATAR })).json() as { attendee: { id: number } };
    const id = me.attendee.id;
    await req(t.app, jar, 'POST', '/api/hunt/start', { trailId: morse.trailId });
    const mine = sheet.slips[4]!.edges;
    await req(t.app, jar, 'POST', '/api/hunt/slip', { stopId, text: mine.left!.word }); // claims copy no. 005, +bonus
    const done = (await req(t.app, jar, 'POST', '/api/hunt/slip', { stopId, text: mine.bottom!.word })).json() as { me: HuntMe };
    expect(done.me.finish?.rank).toBe(1);
    await req(t.app, jar, 'POST', '/api/morse/rounds', { mode: 'decode', level: 1 });
    const txn = run(t.ctx.db, "INSERT INTO stalls_txn (key, attendee_id, stall_id, total_points, free_used, at) VALUES ('k1', ?, ?, 10, 0, 2)", id, stall).lastId;
    run(t.ctx.db, "INSERT INTO stalls_txn_line (txn_id, item_id, item_name, qty, free_qty, price, points) VALUES (?, ?, 'mocktail', 2, 0, 10, 20)", txn, item);
    expect(totals().people).toBe(before.totals.people + 1);
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copies WHERE claimed_by = ?', id)!.n).toBe(1);

    // wrong confirmation: nothing happens; attendees cannot purge
    expect((await req(t.app, admin, 'POST', `/api/admin/participants/${p.id}/purge`, { confirm: 'yes' })).statusCode).toBe(400);
    expect((await req(t.app, jar, 'POST', `/api/admin/participants/${p.id}/purge`, { confirm: '99BD1A90T1' })).statusCode).toBe(401);
    expect(count('attendees')).toBe(before.attendees + 1);

    const r = await req(t.app, admin, 'POST', `/api/admin/participants/${p.id}/purge`, { confirm: '99bd1a90t1' });
    expect(r.statusCode, r.body).toBe(200);
    const report = r.json() as PurgeReport;
    expect(report).toMatchObject({ roll: '99BD1A90T1', attendeeId: id, nickname: 'Mock Tester' });
    expect(report.rows['hunt_slip_copies (released)']).toBe(1);
    for (const tbl of ['points_ledger', 'sticker_unlocks', 'sessions', 'hunt_players', 'hunt_progress', 'hunt_slip_finds', 'morse_rounds', 'stalls_txn']) expect(report.rows[tbl], tbl).toBeGreaterThan(0);

    // as if they never came
    expect(totals()).toEqual(before.totals);
    expect(count('sticker_unlocks')).toBe(before.stickers);
    expect(count('attendees')).toBe(before.attendees);
    expect(count('hunt_slip_finds')).toBe(before.finds);
    expect(one(t.ctx.db, 'SELECT 1 AS x FROM participants WHERE roll = ?', '99BD1A90T1')).toBeUndefined();
    expect(one(t.ctx.db, 'SELECT 1 AS x FROM kits WHERE id = ?', p.kitId as string)).toBeUndefined();
    expect(one<{ c: number | null }>(t.ctx.db, 'SELECT claimed_by AS c FROM hunt_slip_copies WHERE claimed_by = ?', id)).toBeUndefined();
    expect(all(t.ctx.db, 'SELECT * FROM stalls_txn_line')).toEqual([]); // stock is derived: all 5 are back
    for (const tbl of ['morse_rounds', 'hunt_players', 'stalls_txn', 'sessions']) expect(one<{ n: number }>(t.ctx.db, `SELECT COUNT(*) AS n FROM ${tbl} WHERE attendee_id = ?`, id)!.n, tbl).toBe(0);
    // the old session is dead
    expect((await req(t.app, jar, 'GET', '/api/me')).statusCode).toBe(401);
    // the console's views follow: the real player now holds rank 1 of the morse slip board alone, the copy is free
    const board = (await req(t.app, real.jar, 'GET', `/api/hunt/board?trail=${morse.trailId}`)).json() as { crowd: { players: number }; finishers: unknown[] };
    expect(board.crowd.players).toBe(1);
    expect(board.finishers).toEqual([]);
    const copies = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-sets/${morse.setId}/copies`)).json() as { claimed: number };
    expect(copies.claimed).toBe(1);
    // and the copy can be claimed again by someone else
    expect(((await req(t.app, real.jar, 'POST', '/api/hunt/slip', { stopId, text: mine.left!.word })).json() as { outcome: string }).outcome).toBe('taken'); // real already holds no. 002
  });

  it('a participant who never signed in is purged too', async () => {
    const p = (await req(t.app, admin, 'POST', '/api/admin/participants', { name: 'Mock Two', roll: '99BD1A90T2' })).json() as J;
    const r = await req(t.app, admin, 'POST', `/api/admin/participants/${p.id}/purge`, { confirm: '99BD1A90T2' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as PurgeReport).attendeeId).toBeNull();
    expect(one(t.ctx.db, 'SELECT 1 AS x FROM participants WHERE id = ?', p.id as number)).toBeUndefined();
  });
});
