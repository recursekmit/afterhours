import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardResponse } from '@afterhours/shared/features/leaderboard';
import { type Jar, type TestApp, adminJar, capture, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { MAX_PERSONAL_PER_TICK, MOVES_MIN_GAP_MS, tick } from './index';

describe('leaderboard feature', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp({ env: { LOGIN_IP_PER_MIN: '100000' } });
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  /** n attendees; person i has (i+1)*10 points unless `totals` says otherwise. */
  async function crowd(n: number, totals?: number[]) {
    const kits = await makeKits(t.app, n);
    const ppl = await Promise.all(kits.map((k, i) => signedInAttendee(t.app, k, `p${i}`)));
    t.ctx.db.exec('DELETE FROM points_ledger'); // core's sign-in awards would blur the exact totals below
    t.ctx.points.invalidate();
    for (const [i, p] of ppl.entries()) {
      t.clock.advance(10);
      const want = totals?.[i] ?? (i + 1) * 10;
      const have = t.ctx.points.total(p.id);
      if (want > have) t.ctx.points.award({ attendeeId: p.id, source: 'test', ref: 'base', points: want - have });
    }
    return ppl;
  }
  const board = async (jar: Jar | null, q = '') => (await req(t.app, jar, 'GET', `/api/leaderboard${q}`)).json() as BoardResponse;
  const award = (id: number, points: number, ref: string) => t.ctx.points.award({ attendeeId: id, source: 'test', ref, points });
  const full = (r: BoardResponse['rows'][number]) => (r.hidden ? null : r);

  it('top N, unique ranks, "you are #N, X behind the next person"', async () => {
    const ppl = await crowd(5);
    const me = ppl[1]!; // 20 points, 4th of 5
    const b = await board(me.jar, '?limit=3');
    expect(b.rows.map((r) => full(r)?.nickname)).toEqual(['p4', 'p3', 'p2']);
    expect(b.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(b.players).toBe(5);
    expect(b.me).toMatchObject({ rank: 4, total: 20, behind: 10, nextNickname: 'p2', lead: null, tied: false });
    expect(b.me!.neighbours.map((r) => r.rank)).toEqual([2, 3, 4, 5]);
    const leader = (await board(ppl[4]!.jar)).me!;
    expect(leader).toMatchObject({ rank: 1, behind: null, nextNickname: null, lead: 10 });
  });

  it('works for the projector and for admins; rejects anonymous callers', async () => {
    await crowd(3);
    expect((await req(t.app, null, 'GET', '/api/leaderboard')).statusCode).toBe(401);
    const screen = await req(t.app, admin, 'GET', '/api/leaderboard?limit=2');
    const b = screen.json() as BoardResponse;
    expect(b.rows).toHaveLength(2);
    expect(b.me).toBeNull();
    expect((await req(t.app, admin, 'GET', '/api/leaderboard?limit=0')).statusCode).toBe(400);
    expect((await req(t.app, admin, 'GET', '/api/leaderboard?limit=101')).statusCode).toBe(400);
  });

  it('ties: same total keeps distinct ranks, earlier achiever first, flagged tied; me.behind is 0', async () => {
    const ppl = await crowd(4, [50, 50, 50, 10]);
    const b = await board(ppl[2]!.jar);
    const rows = b.rows.map((r) => full(r)!);
    expect(rows.map((r) => r.nickname)).toEqual(['p0', 'p1', 'p2', 'p3']); // p0 reached 50 first
    expect(rows.map((r) => r.tied)).toEqual([true, true, true, false]);
    expect(b.me).toMatchObject({ rank: 3, behind: 0, tied: true });
    // deterministic: asking again gives the same order
    expect((await board(ppl[0]!.jar)).rows.map((r) => full(r)!.nickname)).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('an unranked attendee gets rank null', async () => {
    const [kit] = await makeKits(t.app, 1);
    const p = await signedInAttendee(t.app, kit!, 'zero');
    t.ctx.db.exec('DELETE FROM points_ledger');
    t.ctx.points.invalidate();
    const b = await board(p.jar);
    expect(b.me).toMatchObject({ rank: null, total: 0, behind: null });
  });

  it('live events: a quiet tick sends nothing; a top-10 change sends one small moves event, coalesced', async () => {
    const ppl = await crowd(12);
    const watcher = capture(t.ctx, { attendeeId: null, admin: false, screen: true });
    tick(t.ctx); // baseline
    tick(t.ctx);
    expect(watcher.types()).not.toContain('leaderboard.moves');
    t.clock.advance(MOVES_MIN_GAP_MS + 1);
    award(ppl[0]!.id, 500, 'big'); // p0 jumps from last to first
    award(ppl[1]!.id, 400, 'big');
    tick(t.ctx);
    tick(t.ctx);
    const moves = watcher.events.filter((e) => e.type === 'leaderboard.moves');
    expect(moves).toHaveLength(1);
    const d = moves[0]!.data as { top: { nickname: string }[]; moves: { attendeeId: number; from: number | null; to: number }[] };
    expect(d.top.map((r) => r.nickname).slice(0, 2)).toEqual(['p0', 'p1']);
    expect(d.top).toHaveLength(10);
    expect(d.moves.find((m) => m.attendeeId === ppl[0]!.id)).toMatchObject({ from: 12, to: 1 });
    expect(JSON.stringify(moves[0]).length).toBeLessThan(3000);
    // a second change inside the gap is held back, then delivered
    award(ppl[2]!.id, 900, 'big2');
    t.clock.advance(500);
    tick(t.ctx);
    expect(watcher.events.filter((e) => e.type === 'leaderboard.moves')).toHaveLength(1);
    t.clock.advance(MOVES_MIN_GAP_MS);
    tick(t.ctx);
    expect(watcher.events.filter((e) => e.type === 'leaderboard.moves')).toHaveLength(2);
    watcher.unsub();
  });

  it('personal rank events go only to the person who moved', async () => {
    const ppl = await crowd(6);
    const me = capture(t.ctx, { attendeeId: ppl[0]!.id, admin: false, screen: false });
    const other = capture(t.ctx, { attendeeId: ppl[3]!.id, admin: false, screen: false });
    tick(t.ctx);
    t.clock.advance(MOVES_MIN_GAP_MS + 1);
    award(ppl[0]!.id, 35, 'jump'); // 10 -> 45: from 6th to 3rd
    tick(t.ctx);
    const ev = me.events.find((e) => e.type === 'leaderboard.rank')!.data as { rank: number; previous: number; behind: number };
    expect(ev).toMatchObject({ rank: 3, previous: 6 });
    expect(other.types()).not.toContain('leaderboard.rank'); // overtaken people are not pinged
    me.unsub();
    other.unsub();
  });

  it('mass shuffle: personal events are capped per tick and never broadcast', async () => {
    const ppl = await crowd(150);
    const all = capture(t.ctx, { attendeeId: null, admin: false, screen: true });
    tick(t.ctx);
    t.clock.advance(MOVES_MIN_GAP_MS + 1);
    for (const p of ppl) award(p.id, 1000 - (p.id % 7), 'shuffle');
    tick(t.ctx);
    expect(all.types().filter((x) => x === 'leaderboard.rank')).toHaveLength(0); // addressed to individuals only
    expect(all.types().filter((x) => x === 'leaderboard.moves')).toHaveLength(1);
    expect(MAX_PERSONAL_PER_TICK).toBeLessThan(300);
    all.unsub();
  });

  describe('freeze and reveal', () => {
    it('freeze pins the board; scoring continues; unfreeze catches up', async () => {
      const ppl = await crowd(5);
      const fr = await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { hideTop: false });
      expect(fr.statusCode).toBe(200);
      award(ppl[0]!.id, 1000, 'late');
      t.clock.advance(3000);
      const b = await board(ppl[0]!.jar);
      expect(b.freeze.frozen).toBe(true);
      expect(full(b.rows[0]!)!.nickname).toBe('p4'); // still the old leader
      expect(b.me).toMatchObject({ rank: 5, total: 10, liveTotal: 1010 });
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/unfreeze');
      t.clock.advance(3000);
      const after = await board(ppl[0]!.jar);
      expect(after.freeze.frozen).toBe(false);
      expect(after.me).toMatchObject({ rank: 1 });
    });

    it('no moves/rank events while frozen', async () => {
      const ppl = await crowd(12);
      tick(t.ctx);
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { hideTop: false });
      const w = capture(t.ctx, { attendeeId: ppl[0]!.id, admin: false, screen: true });
      t.clock.advance(MOVES_MIN_GAP_MS + 1);
      award(ppl[0]!.id, 999, 'x');
      tick(t.ctx);
      expect(w.types()).not.toContain('leaderboard.moves');
      expect(w.types()).not.toContain('leaderboard.rank');
      w.unsub();
    });

    it('covers the top N for attendees and projector until the reveal uncovers them, rank by rank', async () => {
      const ppl = await crowd(6);
      const w = capture(t.ctx, { attendeeId: null, admin: false, screen: true });
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { topN: 3, stepMs: 5000, suspenseMs: 4000 });
      const tpl = (await board(ppl[5]!.jar)); // the leader looks at the board
      expect(tpl.rows.slice(0, 3).every((r) => r.hidden)).toBe(true);
      expect(full(tpl.rows[3]!)!.nickname).toBe('p2'); // rank 4 is not covered
      expect(tpl.me).toMatchObject({ rank: null, hiddenInTop: true, behind: null, neighbours: [] });
      expect(tpl.freeze.reveal).toMatchObject({ topN: 3, revealed: 0, startedAt: null });
      expect(JSON.stringify(tpl)).not.toContain('"p5"'); // covered nicknames never leave the server
      // peek is admin only
      expect((await board(ppl[0]!.jar, '?peek=1')).rows.some((r) => r.hidden)).toBe(true);
      expect(full((await board(admin, '?peek=1')).rows[0]!)!.nickname).toBe('p5');
      expect((await board(admin)).rows[0]!.hidden).toBe(true);

      expect((await req(t.app, ppl[0]!.jar, 'POST', '/api/leaderboard/admin/reveal', {})).statusCode).toBe(401);
      expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/reveal', {})).statusCode).toBe(200);
      expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/reveal', {})).statusCode).toBe(409);
      // place 3 uncovered immediately
      let b = await board(ppl[0]!.jar);
      expect(b.freeze.reveal).toMatchObject({ revealed: 1, done: false });
      expect(full(b.rows[2]!)!.nickname).toBe('p3');
      expect(b.rows[1]!.hidden).toBe(true);
      expect(b.freeze.reveal!.schedule).toHaveLength(3);
      t.clock.advance(5000);
      tick(t.ctx);
      b = await board(ppl[0]!.jar);
      expect(full(b.rows[1]!)!.nickname).toBe('p4');
      expect(b.rows[0]!.hidden).toBe(true);
      t.clock.advance(5000); // rank 1 waits for the extra suspense beat
      tick(t.ctx);
      expect((await board(ppl[0]!.jar)).rows[0]!.hidden).toBe(true);
      t.clock.advance(4000);
      tick(t.ctx);
      tick(t.ctx);
      b = await board(ppl[5]!.jar);
      expect(b.freeze.reveal!.done).toBe(true);
      expect(full(b.rows[0]!)!.nickname).toBe('p5');
      expect(b.me).toMatchObject({ rank: 1, hiddenInTop: false });
      const steps = w.events.filter((e) => e.type === 'leaderboard.reveal').map((e) => e.data as { rank: number; done: boolean });
      expect(steps.map((s) => s.rank)).toEqual([3, 2, 1]); // each place once, in order
      expect(steps.map((s) => s.done)).toEqual([false, false, true]);
      // stickers for the final top places
      expect(t.ctx.stickers.unlockedBy(ppl[5]!.id)['leaderboard-champ']).toBeDefined();
      expect(t.ctx.stickers.unlockedBy(ppl[3]!.id)['leaderboard-top10']).toBeDefined();
      expect(t.ctx.stickers.unlockedBy(ppl[0]!.id)['leaderboard-top10']).toBeUndefined();
      w.unsub();
    });

    it('reveal needs a freeze; restart replays; unfreeze clears', async () => {
      await crowd(4);
      expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/reveal', {})).statusCode).toBe(409);
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { topN: 2 });
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/reveal', {});
      t.clock.advance(60_000);
      tick(t.ctx);
      expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/reveal', { restart: true })).statusCode).toBe(200);
      const b = await board(admin);
      expect(b.freeze.reveal).toMatchObject({ revealed: 1, done: false });
      expect(b.rows[0]!.hidden).toBe(true);
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/unfreeze');
      t.clock.advance(3000);
      const live = await board(admin);
      expect(live.freeze).toMatchObject({ frozen: false, reveal: null });
      expect(live.rows[0]!.hidden).toBe(false);
    });

    it('freeze with fewer players than topN shrinks topN; freeze is console-only', async () => {
      const ppl = await crowd(2);
      expect((await req(t.app, ppl[0]!.jar, 'POST', '/api/leaderboard/admin/freeze', {})).statusCode).toBe(401);
      const r = (await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { topN: 10 })).json() as { reveal: { topN: number } };
      expect(r.reveal.topN).toBe(2);
      expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { topN: 0 })).statusCode).toBe(400);
    });
  });

  it('300 attendees fetching the board stay fast, and the tick is cheap', async () => {
    const ppl = await crowd(300, Array.from({ length: 300 }, (_, i) => 1 + ((i * 37) % 250)));
    const t0 = performance.now();
    const rs = await Promise.all(ppl.map((p) => req(t.app, p.jar, 'GET', '/api/leaderboard?limit=10')));
    const ms = performance.now() - t0;
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(ms).toBeLessThan(4000);
    tick(t.ctx);
    t.clock.advance(MOVES_MIN_GAP_MS + 1);
    for (const p of ppl) award(p.id, 5 + (p.id % 11), 'burst');
    const t1 = performance.now();
    tick(t.ctx);
    expect(performance.now() - t1).toBeLessThan(300);
  }, 60_000);
  it('"I am here": only people who tapped are on the prize board, in live board order', async () => {
    const ppl = await crowd(5); // p4 has the most
    expect(((await req(t.app, null, 'POST', '/api/leaderboard/here')).statusCode)).toBe(401);
    expect((await req(t.app, ppl[1]!.jar, 'GET', '/api/leaderboard/here')).json()).toMatchObject({ here: false });
    for (const i of [1, 3, 0]) expect((await req(t.app, ppl[i]!.jar, 'POST', '/api/leaderboard/here')).json()).toMatchObject({ here: true });
    await req(t.app, ppl[3]!.jar, 'POST', '/api/leaderboard/here'); // twice is fine
    expect((await req(t.app, ppl[1]!.jar, 'GET', '/api/leaderboard/here')).json()).toMatchObject({ here: true });
    expect((await req(t.app, ppl[1]!.jar, 'GET', '/api/leaderboard/admin/here')).statusCode).toBe(401);
    const hb = (await req(t.app, admin, 'GET', '/api/leaderboard/admin/here')).json() as { rows: { place: number; rank: number; nickname: string }[]; here: number };
    expect(hb.here).toBe(3);
    expect(hb.rows.map((r) => [r.place, r.nickname, r.rank])).toEqual([[1, 'p3', 2], [2, 'p1', 4], [3, 'p0', 5]]);
    expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/here/clear', { confirm: 'CLEAR' })).json()).toMatchObject({ here: 0, rows: [] });
  });
});
