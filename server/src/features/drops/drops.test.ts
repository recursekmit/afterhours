import type { LiveEnvelope } from '@afterhours/shared';
import {
  type AdminDrop,
  type ClaimResponse,
  type CreateDropRequest,
  type CurrentDropResponse,
  DROP_LEAD_MS,
  type DropsAdminState,
  type FeedState,
  type MyStreak,
  type ScreenDropResponse,
  speedPoints,
} from '@afterhours/shared/features/drops';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, AVATAR, Jar, adminJar, capture, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { createSession } from '../../core/auth/sessions';
import { run } from '../../core/db';
import type { PushSender } from '../../core/push/service';
import { flush as flushReactions } from '../reactions/index';
import { FEED_FLUSH_MS, FEED_MAX_PER_FLUSH, FEED_MAX_PER_MIN, flushFeed, pendingCount, push as feedPush } from './feed';
import { tick } from './index';
import { HYPE_EVERY_MS } from './pulse';
import { flushTally } from './service';
import { streakFrom } from './streak';
import { setVisibility } from '../hunt/visibility';

const STAFF = { attendeeId: null, admin: true, screen: true } as const;
const SCREEN = { attendeeId: null, admin: false, screen: true } as const;

/** n signed-in attendees with finished profiles, made directly (no scrypt, no login rate limit). */
function crowd(t: TestApp, n: number, prefix = 'p'): { jar: Jar; id: number; nick: string }[] {
  const out: { jar: Jar; id: number; nick: string }[] = [];
  const now = t.ctx.now();
  for (let i = 0; i < n; i++) {
    const kit = `AH-${String(5000 + out.length + Math.floor(Math.random() * 1e6)).slice(-6)}`;
    run(t.ctx.db, 'INSERT INTO kits (id, password_hash, created_at) VALUES (?, ?, ?)', kit, 'x', now);
    const nick = `${prefix}${i}`;
    const r = run(
      t.ctx.db,
      'INSERT INTO attendees (kit_id, name, roll, nickname, avatar, profile_complete, first_signin_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      kit,
      `Person ${i}`,
      `R${i}`,
      nick,
      JSON.stringify(AVATAR),
      now,
    );
    const { token } = createSession(t.ctx, 'attendee', r.lastId);
    const jar = new Jar();
    jar.cookies.ah_sid = token;
    out.push({ jar, id: r.lastId, nick });
  }
  t.ctx.points.invalidate();
  return out;
}

describe('drops feature', () => {
  let t: TestApp;
  let admin: Jar;
  let sent: { title: string; body: string; url: string }[];
  const sender: PushSender = async (_s, body) => {
    sent.push(JSON.parse(body) as { title: string; body: string; url: string });
  };

  beforeEach(async () => {
    sent = [];
    t = await makeApp({ pushSender: sender });
    setVisibility(t.ctx, { hunt: true, morse: true }); // both events are hidden from players by default
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  const create = async (body: CreateDropRequest): Promise<AdminDrop> => {
    const r = await req(t.app, admin, 'POST', '/api/drops/admin', body);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as AdminDrop;
  };
  const claimAs = async (jar: Jar, id: number, answer: string) => {
    const r = await req(t.app, jar, 'POST', `/api/drops/${id}/claim`, { answer });
    return { status: r.statusCode, body: r.json() as ClaimResponse };
  };
  const open = () => t.clock.advance(DROP_LEAD_MS);
  const codeDrop = (over: Partial<{ code: string; winners: number; winPoints: number; restPoints: number; display: 'plain' | 'morse' }> = {}, durationSec = 60) =>
    create({ title: 'flash', durationSec, when: 'now', config: { kind: 'code', code: 'SUDO', winners: 2, winPoints: 15, restPoints: 3, ...over } });

  describe('code drop', () => {
    it('first N win big, the rest of the window gets a little, then the window shuts', async () => {
      const [a, b, c, d] = crowd(t, 4);
      const d0 = await codeDrop();
      expect(d0.status).toBe('live');
      expect(d0.opensAt).toBe(t.clock.now() + DROP_LEAD_MS);

      // before the window: refused, nothing stored
      expect((await claimAs(a!.jar, d0.id, 'sudo')).status).toBe(409);
      open();
      expect((await claimAs(a!.jar, d0.id, ' s-u-d-o ')).body).toMatchObject({ outcome: 'won', rank: 1, points: 15 });
      expect((await claimAs(b!.jar, d0.id, 'nope')).body).toMatchObject({ outcome: 'wrong', attemptsLeft: 5 });
      expect((await claimAs(b!.jar, d0.id, 'SUDO')).body).toMatchObject({ outcome: 'won', rank: 2, points: 15 });
      expect((await claimAs(c!.jar, d0.id, 'SUDO')).body).toMatchObject({ outcome: 'bonus', rank: 3, points: 3 });
      // pays once
      expect((await claimAs(a!.jar, d0.id, 'SUDO')).body).toMatchObject({ outcome: 'already', points: 15 });
      expect(t.ctx.points.total(a!.id)).toBe(15);
      expect(t.ctx.points.total(c!.id)).toBe(3);
      expect(t.ctx.stickers.unlockedBy(a!.id)['drops-quickdraw']).toBeDefined();
      expect(t.ctx.stickers.unlockedBy(c!.id)['drops-quickdraw']).toBeUndefined();

      // window over (server clock): too slow, no points
      t.clock.advance(60_000);
      expect((await claimAs(d!.jar, d0.id, 'SUDO')).body).toMatchObject({ outcome: 'too_slow', points: 0 });
      expect(t.ctx.points.total(d!.id)).toBe(0);
      const cur = (await req(t.app, d!.jar, 'GET', '/api/drops/current')).json() as CurrentDropResponse;
      expect(cur.drop).toMatchObject({ status: 'closed', reveal: 'SUDO' });
      expect(cur.tally?.winners.map((w) => w.nickname)).toEqual(['p0', 'p1', 'p2']);
    });

    it('runs out of tries', async () => {
      const [a] = crowd(t, 1);
      const d0 = await codeDrop();
      open();
      let last: ClaimResponse | null = null;
      for (let i = 0; i < 6; i++) last = (await claimAs(a!.jar, d0.id, `X${i}`)).body;
      expect(last).toMatchObject({ outcome: 'out', attemptsLeft: 0 });
      t.clock.advance(8000);
      expect((await claimAs(a!.jar, d0.id, 'SUDO')).body.outcome).toBe('out');
    });

    it('a morse drop shows dots and dashes on the projector, never the word', async () => {
      const screen = capture(t.ctx, SCREEN);
      const d0 = await codeDrop({ code: 'PING', display: 'morse' });
      const ch = screen.events.find((e) => e.type === 'drops.challenge') as LiveEnvelope<'drops.challenge'> | undefined;
      expect(ch?.data.challenge).toEqual({ display: 'morse', patterns: ['.--.', '..', '-.', '--.'] });
      const s = (await req(t.app, admin, 'GET', '/api/drops/screen')).json() as ScreenDropResponse;
      expect(JSON.stringify(s)).not.toContain('PING');
      expect(s.drop?.display).toBe('morse');
      screen.unsub();
      expect(d0.config).toMatchObject({ code: 'PING' });
    });
  });

  describe('speed question', () => {
    it('choice: first right answer wins big, then down the ladder; one shot each', async () => {
      const ppl = crowd(t, 6);
      const d0 = await create({
        title: 'speed',
        durationSec: 30,
        when: 'now',
        config: { kind: 'speed', question: '418?', choices: ['teapot', 'gone', 'nope'], correct: 0, topPoints: 30, floorPoints: 5 },
      });
      open();
      expect((await claimAs(ppl[0]!.jar, d0.id, '1')).body).toMatchObject({ outcome: 'out' }); // wrong, and that was the one shot
      expect((await claimAs(ppl[0]!.jar, d0.id, '0')).body).toMatchObject({ outcome: 'out' });
      const got: ClaimResponse[] = [];
      for (const p of ppl.slice(1)) got.push((await claimAs(p.jar, d0.id, '0')).body);
      expect(got.map((g) => g.points)).toEqual([1, 2, 3, 4, 5].map((r) => speedPoints(r, 30, 5)));
      expect(got.map((g) => g.points)).toEqual([30, 23, 17, 13, 9]);
      expect(got.map((g) => g.outcome)).toEqual(['won', 'won', 'won', 'bonus', 'bonus']);
      const s = (await req(t.app, admin, 'GET', '/api/drops/screen')).json() as ScreenDropResponse;
      expect(s.tally?.winners[0]?.nickname).toBe('p1'); // "first: p1"
    });

    it('typed: any accepted spelling, three tries', async () => {
      const [a, b] = crowd(t, 2);
      const d0 = await create({ title: 'speed', durationSec: 30, when: 'now', config: { kind: 'speed', question: 'bits in a nibble?', answers: ['4', 'four'] } });
      open();
      expect((await claimAs(a!.jar, d0.id, '5')).body).toMatchObject({ outcome: 'wrong', attemptsLeft: 2 });
      expect((await claimAs(a!.jar, d0.id, 'FOUR')).body).toMatchObject({ outcome: 'won', rank: 1, points: 30 });
      for (const x of ['1', '2']) await claimAs(b!.jar, d0.id, x);
      expect((await claimAs(b!.jar, d0.id, '3')).body.outcome).toBe('out');
    });

    it('rejects a choice question without a right answer', async () => {
      const r = await req(t.app, admin, 'POST', '/api/drops/admin', { title: 'x', config: { kind: 'speed', question: 'q', choices: ['a', 'b'] } });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('golden slip', () => {
    it('first finder takes the bonus and the sticker, the drop closes, the projector hears it', async () => {
      const [a, b] = crowd(t, 2, 'meg');
      const screen = capture(t.ctx, SCREEN);
      const d0 = await create({ title: 'gold', durationSec: 900, when: 'now', config: { kind: 'golden', token: 'goldenbyte', hint: 'near the chai', bonus: 50 } });
      open();
      expect((await claimAs(a!.jar, d0.id, 'golden-byte')).body).toMatchObject({ outcome: 'won', points: 50 });
      expect(t.ctx.stickers.unlockedBy(a!.id)['drops-golden']).toBeDefined();
      expect((await claimAs(b!.jar, d0.id, 'GOLDENBYTE')).body).toMatchObject({ outcome: 'too_slow', points: 0 });
      const closed = screen.events.find((e) => e.type === 'drops.closed') as LiveEnvelope<'drops.closed'>;
      expect(closed.data.drop).toMatchObject({ status: 'closed', reveal: 'GOLDENBYTE' });
      expect(closed.data.tally.winners[0]?.nickname).toBe('meg0');
      flushFeed(t.ctx, true);
      const feed = (await req(t.app, a!.jar, 'GET', '/api/drops/feed')).json() as FeedState;
      expect(feed.items.map((i) => i.text)).toContain('golden slip found by meg0!');
      screen.unsub();
    });
  });

  describe('everyone wins (room)', () => {
    it('reactions on the bus and button taps fill the goal; everyone in the room is paid once', async () => {
      const ppl = crowd(t, 5);
      const d0 = await create({ title: 'room', durationSec: 60, when: 'now', config: { kind: 'room', goal: 30, points: 5 } });
      // reactions before the window opens do not count
      await req(t.app, ppl[0]!.jar, 'POST', '/api/reactions', { kind: 'fire' });
      flushReactions(t.ctx);
      tick(t.ctx);
      open();
      for (const p of ppl) for (let i = 0; i < 4; i++) await req(t.app, p.jar, 'POST', '/api/reactions', { kind: 'fire' });
      flushReactions(t.ctx);
      tick(t.ctx);
      let s = (await req(t.app, admin, 'GET', '/api/drops/screen')).json() as ScreenDropResponse;
      expect(s.tally).toMatchObject({ count: 20, goal: 30 });
      // taps: 10 more closes it
      const r = await req(t.app, ppl[1]!.jar, 'POST', `/api/drops/${d0.id}/tap`, { n: 10 });
      expect(r.json()).toEqual({ count: 30 });
      s = (await req(t.app, admin, 'GET', '/api/drops/screen')).json() as ScreenDropResponse;
      expect(s.drop).toMatchObject({ status: 'closed', achieved: true });
      for (const p of ppl) expect(t.ctx.points.history(p.id).filter((h) => h.source === 'drops')).toHaveLength(1);
      // a late tap changes nothing
      expect((await req(t.app, ppl[2]!.jar, 'POST', `/api/drops/${d0.id}/tap`, { n: 3 })).statusCode).toBe(409);
      expect(t.ctx.points.total(ppl[2]!.id)).toBe(5);
    });

    it('misses the goal: nobody is paid', async () => {
      const [a] = crowd(t, 1);
      const d0 = await create({ title: 'room', durationSec: 10, when: 'now', config: { kind: 'room', goal: 100, points: 5 } });
      open();
      await req(t.app, a!.jar, 'POST', `/api/drops/${d0.id}/tap`, { n: 5 });
      t.clock.advance(11_000);
      tick(t.ctx);
      const cur = (await req(t.app, a!.jar, 'GET', '/api/drops/current')).json() as CurrentDropResponse;
      expect(cur.drop).toMatchObject({ status: 'closed', achieved: false });
      expect(t.ctx.points.total(a!.id)).toBe(0);
    });
  });

  describe('fairness', () => {
    it('first-N ordering holds under concurrent claims', async () => {
      const ppl = crowd(t, 40);
      const d0 = await codeDrop({ winners: 10 });
      open();
      const res = await Promise.all(ppl.map((p) => claimAs(p.jar, d0.id, 'SUDO')));
      const ranks = res.map((r) => r.body.rank);
      expect(new Set(ranks).size).toBe(40);
      expect([...ranks].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(res.filter((r) => r.body.outcome === 'won')).toHaveLength(10);
      expect(res.filter((r) => r.body.outcome === 'won').every((r) => (r.body.rank ?? 99) <= 10)).toBe(true);
      // arrival order: inject resolves in order on one process
      expect(ranks).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });

    it('rate limits answers and taps', async () => {
      const [a] = crowd(t, 1);
      const d0 = await codeDrop({}, 60);
      open();
      let limited = 0;
      for (let i = 0; i < 12; i++) if ((await claimAs(a!.jar, d0.id, `W${i}`)).status === 429) limited++;
      expect(limited).toBe(4);

      await req(t.app, admin, 'POST', `/api/drops/admin/${d0.id}/cancel`);
      const room = await create({ title: 'room', durationSec: 60, when: 'now', config: { kind: 'room', goal: 5000 } });
      open();
      let count = 0;
      for (let i = 0; i < 12; i++) {
        const r = await req(t.app, a!.jar, 'POST', `/api/drops/${room.id}/tap`, { n: 10 });
        if (r.statusCode === 200) count = (r.json() as { count: number }).count;
      }
      expect(count).toBe(20); // 20 taps per 4 s per person, however hard you mash
    });

    it('keeps secrets: no answer in any attendee or projector payload before close', async () => {
      const [a] = crowd(t, 1);
      const phone = capture(t.ctx, { attendeeId: a!.id, admin: false, screen: false });
      const screen = capture(t.ctx, SCREEN);
      const payloads: string[] = [];
      const look = async () => {
        payloads.push((await req(t.app, a!.jar, 'GET', '/api/drops/current')).body);
        payloads.push((await req(t.app, admin, 'GET', '/api/drops/screen')).body);
      };
      const sp = await create({ title: 'speed', durationSec: 30, when: 'now', config: { kind: 'speed', question: 'which?', choices: ['alpha', 'zebraquark'], correct: 1 } });
      await look();
      open();
      await claimAs(a!.jar, sp.id, '0');
      await look();
      await req(t.app, admin, 'POST', `/api/drops/admin/${sp.id}/cancel`);
      const typed = await create({ title: 'typed', durationSec: 30, when: 'now', config: { kind: 'speed', question: 'say it', answers: ['XYLOPHONIC'] } });
      open();
      await look();
      await req(t.app, admin, 'POST', `/api/drops/admin/${typed.id}/cancel`);
      const gold = await create({ title: 'gold', durationSec: 300, when: 'now', config: { kind: 'golden', token: 'MOONSLIPPER' } });
      open();
      await look();
      await req(t.app, admin, 'POST', `/api/drops/admin/${gold.id}/cancel`);
      const code = await create({ title: 'code', durationSec: 30, when: 'now', config: { kind: 'code', code: 'QWERTZ' } });
      void code;
      tick(t.ctx);
      flushTally(t.ctx, true);
      await look();

      const phoneText = payloads.filter((_, i) => i % 2 === 0).join('\n') + JSON.stringify(phone.events);
      const screenText = payloads.filter((_, i) => i % 2 === 1).join('\n') + JSON.stringify(screen.events);
      // the "correct" index must not be in the payload either: choices go out, the right one does not
      expect(phoneText).not.toMatch(/"correct"/);
      expect(screenText).not.toMatch(/"correct"/);
      for (const secret of ['XYLOPHONIC', 'MOONSLIPPER', 'QWERTZ']) expect(phoneText).not.toContain(secret);
      for (const secret of ['XYLOPHONIC', 'MOONSLIPPER']) expect(screenText).not.toContain(secret);
      // zebraquark is a visible choice (fine), but no reveal of it while live
      expect(phoneText).not.toMatch(/"reveal":"zebraquark"/);
      phone.unsub();
      screen.unsub();
    });

    it('console routes need the PIN, projector routes need the screen PIN', async () => {
      const [a] = crowd(t, 1);
      expect((await req(t.app, a!.jar, 'GET', '/api/drops/admin')).statusCode).toBe(401);
      expect((await req(t.app, a!.jar, 'POST', '/api/drops/admin', { title: 'x', config: { kind: 'room' } })).statusCode).toBe(401);
      expect((await req(t.app, a!.jar, 'GET', '/api/drops/screen')).statusCode).toBe(401);
      expect((await req(t.app, null, 'GET', '/api/drops/current')).statusCode).toBe(401);
      expect((await req(t.app, null, 'GET', '/api/drops/feed')).statusCode).toBe(401);
    });

    it('one drop at a time', async () => {
      await codeDrop();
      const r = await req(t.app, admin, 'POST', '/api/drops/admin', { title: 'two', when: 'now', config: { kind: 'room' } });
      expect(r.statusCode).toBe(409);
      const st = (await req(t.app, admin, 'GET', '/api/drops/admin')).json() as DropsAdminState;
      expect(st.drops).toHaveLength(1);
    });
  });

  describe('scheduling and push', () => {
    it('fires a scheduled drop on the server clock, pushes everyone, teases phones first', async () => {
      const [a] = crowd(t, 1);
      t.ctx.push.subscribe(a!.id, { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } });
      const at = t.clock.now() + 5 * 60_000;
      const d0 = await create({ title: 'later', durationSec: 60, when: { at }, config: { kind: 'code', code: 'LATER' } });
      expect(d0.status).toBe('scheduled');
      let cur = (await req(t.app, a!.jar, 'GET', '/api/drops/current')).json() as CurrentDropResponse;
      expect(cur).toMatchObject({ drop: null, nextAt: null }); // too far out to tease
      t.clock.advance(2 * 60_000 + 30_000);
      cur = (await req(t.app, a!.jar, 'GET', '/api/drops/current')).json() as CurrentDropResponse;
      expect(cur.nextAt).toBe(at);
      expect(JSON.stringify(cur)).not.toContain('LATER');
      const phone = capture(t.ctx, { attendeeId: a!.id, admin: false, screen: false });
      t.clock.advance(2 * 60_000 + 29_000);
      tick(t.ctx);
      expect(phone.types()).not.toContain('drops.live');
      t.clock.advance(1000);
      tick(t.ctx);
      expect(phone.types()).toContain('drops.live');
      await new Promise((r) => setTimeout(r, 10));
      expect(sent).toEqual([{ title: 'drop live! 60s', body: 'later', url: '/drops', tag: 'drops' }]);
      phone.unsub();
    });

    it('a scheduled drop waits for the live one to finish', async () => {
      await codeDrop({}, 20);
      const at = t.clock.now() + 10_000;
      const d1 = await create({ title: 'next', durationSec: 30, when: { at }, config: { kind: 'room' } });
      t.clock.advance(15_000);
      tick(t.ctx);
      let st = (await req(t.app, admin, 'GET', '/api/drops/admin')).json() as DropsAdminState;
      expect(st.drops.find((d) => d.id === d1.id)?.status).toBe('scheduled');
      t.clock.advance(10_000);
      tick(t.ctx);
      st = (await req(t.app, admin, 'GET', '/api/drops/admin')).json() as DropsAdminState;
      expect(st.drops.find((d) => d.id === d1.id)?.status).toBe('live');
    });

    it('fires a library drop in one call', async () => {
      const r = await req(t.app, admin, 'POST', '/api/drops/admin/library/speed-418', {});
      expect(r.statusCode).toBe(200);
      expect((r.json() as AdminDrop).status).toBe('live');
      expect((await req(t.app, admin, 'POST', '/api/drops/admin/library/room-200', {})).statusCode).toBe(409);
    });
  });

  describe('live feed', () => {
    const stamp = (nickname: string, solved: number) =>
      t.ctx.live.publish('hunt.stamp', { trailId: 1, nickname, avatar: AVATAR, solved, total: 6, at: t.ctx.now() }, 'screens');

    it('coalesces bursts into one line and rate-limits the broadcast', async () => {
      const [a] = crowd(t, 1);
      const all = capture(t.ctx, STAFF);
      stamp('sana', 3);
      tick(t.ctx);
      let feeds = all.events.filter((e) => e.type === 'drops.feed') as LiveEnvelope<'drops.feed'>[];
      expect(feeds.flatMap((f) => f.data.items.map((i) => i.text))).toEqual(['sana found stop 3']);
      for (const n of ['meg', 'arjun', 'tara', 'veer', 'ila']) stamp(n, 2);
      tick(t.ctx);
      feeds = all.events.filter((e) => e.type === 'drops.feed') as LiveEnvelope<'drops.feed'>[];
      expect(feeds).toHaveLength(1); // inside the flush window: nothing yet
      t.clock.advance(FEED_FLUSH_MS);
      tick(t.ctx);
      feeds = all.events.filter((e) => e.type === 'drops.feed') as LiveEnvelope<'drops.feed'>[];
      expect(feeds).toHaveLength(2);
      expect(feeds[1]?.data.items.map((i) => i.text)).toEqual(['meg, arjun and 3 others found stops']);
      const st = (await req(t.app, a!.jar, 'GET', '/api/drops/feed')).json() as FeedState;
      expect(st.items.map((i) => i.text)).toEqual(['sana found stop 3', 'meg, arjun and 3 others found stops']);
      all.unsub();
    });

    it('caps lines per flush and per minute, big moments still get through', async () => {
      const all = capture(t.ctx, STAFF);
      for (let i = 0; i < 40; i++) feedPush(t.ctx, { key: `x${i}`, priority: 2, tone: 'info', icon: 'dot', text: `line ${i}` });
      for (let k = 0; k < 10; k++) {
        flushFeed(t.ctx);
        t.clock.advance(FEED_FLUSH_MS);
      }
      const items = (all.events.filter((e) => e.type === 'drops.feed') as LiveEnvelope<'drops.feed'>[]).map((e) => e.data.items);
      expect(items.every((i) => i.length <= FEED_MAX_PER_FLUSH)).toBe(true);
      expect(items.flat().length).toBe(FEED_MAX_PER_MIN);
      feedPush(t.ctx, { key: 'gold', priority: 3, tone: 'win', icon: 'crown', text: 'golden slip found by meg!' });
      flushFeed(t.ctx);
      const last = all.events.at(-1) as LiveEnvelope<'drops.feed'>;
      expect(last.data.items.map((i) => i.text)).toEqual(['golden slip found by meg!']);
      expect(pendingCount(t.ctx)).toBeLessThanOrEqual(40);
      all.unsub();
    });

    it('derives lines from other features and the schedule (read-only)', async () => {
      const all = capture(t.ctx, STAFF);
      const start = t.clock.now() + 3 * 60_000;
      await req(t.app, admin, 'POST', '/api/schedule', { title: 'quiz', kind: 'poll', startAt: start, endAt: start + 20 * 60_000 });
      tick(t.ctx); // primes
      t.clock.advance(61_000);
      t.ctx.live.publish('arcade.record', { game: 'reaction', attendeeId: 1, nickname: 'player7', avatar: AVATAR, score: 200, label: '200ms', previous: null }, 'all');
      t.ctx.live.publish('attendance.arrivals', { activityId: '1', names: ['a1', 'a2', 'a3'] }, 'screens');
      tick(t.ctx);
      t.clock.advance(FEED_FLUSH_MS);
      tick(t.ctx);
      const texts = (all.events.filter((e) => e.type === 'drops.feed') as LiveEnvelope<'drops.feed'>[]).flatMap((e) => e.data.items.map((i) => i.text));
      expect(texts).toContain('player7 took #1 on lag spike');
      expect(texts).toContain('quiz starts in 2 min');
      expect(texts).toContain('a1, a2 and 1 other just checked in');
      all.unsub();
    });

    it('organisers can mute it and hide a line', async () => {
      const [a] = crowd(t, 1);
      await req(t.app, admin, 'POST', '/api/drops/admin/feed', { text: 'pizza in 10' });
      let st = (await req(t.app, a!.jar, 'GET', '/api/drops/feed')).json() as FeedState;
      expect(st.items.map((i) => i.text)).toEqual(['pizza in 10']);
      const id = st.items[0]!.id;
      const all = capture(t.ctx, STAFF);
      expect((await req(t.app, admin, 'POST', `/api/drops/admin/feed/${id}/hide`)).statusCode).toBe(200);
      expect((all.events.at(-1) as LiveEnvelope<'drops.feed'>).data.hidden).toEqual([id]);
      st = (await req(t.app, a!.jar, 'GET', '/api/drops/feed')).json() as FeedState;
      expect(st.items).toEqual([]);
      await req(t.app, admin, 'PATCH', '/api/drops/admin/settings', { feedMuted: true });
      expect((all.events.at(-1) as LiveEnvelope<'drops.feed'>).data.muted).toBe(true);
      stamp('sana', 1);
      t.clock.advance(FEED_FLUSH_MS);
      tick(t.ctx);
      st = (await req(t.app, a!.jar, 'GET', '/api/drops/feed')).json() as FeedState;
      expect(st).toEqual({ items: [], muted: true });
      all.unsub();
    });
  });

  describe('hype', () => {
    it('fills with activity, sets the room on fire once, and can fire an everyone-wins drop', async () => {
      await req(t.app, admin, 'PATCH', '/api/drops/admin/settings', { hypeTarget: 40, hypeAuto: true });
      const ppl = crowd(t, 10);
      const all = capture(t.ctx, STAFF);
      for (const p of ppl) for (let i = 0; i < 5; i++) await req(t.app, p.jar, 'POST', '/api/reactions', { kind: 'party' });
      flushReactions(t.ctx);
      t.clock.advance(HYPE_EVERY_MS);
      tick(t.ctx);
      const hype = all.events.filter((e) => e.type === 'drops.hype').at(-1) as LiveEnvelope<'drops.hype'>;
      expect(hype.data.level).toBe(1);
      const fire = all.events.filter((e) => e.type === 'drops.on-fire') as LiveEnvelope<'drops.on-fire'>[];
      expect(fire).toHaveLength(1);
      expect(fire[0]?.data.dropId).not.toBeNull();
      expect(all.types()).toContain('drops.live');
      t.clock.advance(HYPE_EVERY_MS);
      tick(t.ctx);
      expect(all.events.filter((e) => e.type === 'drops.on-fire')).toHaveLength(1); // cooldown
      all.unsub();
    });
  });

  describe('streaks', () => {
    it('pure: counts consecutive activities, the live one cannot break it', () => {
      const w = (from: number, to: number, live = false) => ({ title: `${from}`, from, to, live });
      const ws = [w(0, 10), w(10, 20), w(20, 30), w(30, 40), w(40, 50, true)];
      expect(streakFrom(ws, [5, 25, 35]).streak).toBe(2);
      expect(streakFrom(ws, [5, 15, 25, 35]).streak).toBe(4);
      expect(streakFrom(ws, [5, 15, 25, 35, 45])).toMatchObject({ streak: 5, best: 5 });
      expect(streakFrom(ws, [5, 15, 45]).streak).toBe(1);
      expect(streakFrom(ws, [5, 15, 45])).toMatchObject({ best: 2 });
    });

    it('3 in a row on the real schedule unlocks the sticker once', async () => {
      const [a] = crowd(t, 1);
      const t0 = t.clock.now();
      for (let i = 0; i < 3; i++) {
        await req(t.app, admin, 'POST', '/api/schedule', { title: `slot ${i}`, kind: 'game', startAt: t0 + i * 600_000, endAt: t0 + (i + 1) * 600_000 });
      }
      await req(t.app, admin, 'POST', '/api/schedule', { title: 'chai', kind: 'break', startAt: t0 + 1_800_000, endAt: t0 + 2_400_000 });
      for (let i = 0; i < 3; i++) {
        t.clock.set(t0 + i * 600_000 + 60_000);
        t.ctx.points.award({ attendeeId: a!.id, source: 'test', ref: `x${i}`, points: 1 });
      }
      t.clock.set(t0 + 1_900_000);
      const s = (await req(t.app, a!.jar, 'GET', '/api/drops/me')).json() as MyStreak;
      expect(s).toMatchObject({ streak: 3, best: 3 });
      expect(s.recent.map((r) => r.did)).toEqual([true, true, true]);
      expect(t.ctx.stickers.unlockedBy(a!.id)['drops-streak']).toBeDefined();
      await req(t.app, a!.jar, 'GET', '/api/drops/me');
      expect(t.ctx.points.total(a!.id)).toBe(3 + 5);
    });
  });

  it('300 phones claim a code drop at once: 20 winners, everyone paid once, tallies coalesced', async () => {
    const ppl = crowd(t, 300);
    const d0 = await codeDrop({ winners: 20, code: 'RECURSE' }, 60);
    open();
    tick(t.ctx);
    const watch = capture(t.ctx, STAFF);
    const started = Date.now();
    const res = await Promise.all(ppl.map((p) => claimAs(p.jar, d0.id, 'recurse')));
    const ms = Date.now() - started;
    t.clock.advance(1000);
    tick(t.ctx);
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(res.filter((r) => r.body.outcome === 'won')).toHaveLength(20);
    expect(res.filter((r) => r.body.outcome === 'bonus')).toHaveLength(280);
    const ranks = new Set(res.map((r) => r.body.rank));
    expect(ranks.size).toBe(300);
    const rows = t.ctx.db.prepare("SELECT COUNT(*) AS n, SUM(points) AS p FROM points_ledger WHERE source = 'drops'").get() as { n: number; p: number };
    expect(rows).toEqual({ n: 300, p: 20 * 15 + 280 * 3 });
    // 300 claims, one tick: one tally on the wire, not 300
    expect(watch.events.filter((e) => e.type === 'drops.tally')).toHaveLength(1);
    expect((watch.events.find((e) => e.type === 'drops.tally') as LiveEnvelope<'drops.tally'>).data).toMatchObject({ claimed: 300, players: 300 });
    expect(ms).toBeLessThan(15_000);
    watch.unsub();
    // and a second wave pays nothing
    const again = await Promise.all(ppl.slice(0, 50).map((p) => claimAs(p.jar, d0.id, 'RECURSE')));
    expect(again.every((r) => r.body.outcome === 'already' || r.status === 429)).toBe(true);
    expect((t.ctx.db.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE source = 'drops'").get() as { n: number }).n).toBe(300);
  }, 60_000);

  it('danger zone reset takes points and stickers back', async () => {
    const [a] = crowd(t, 1);
    const d0 = await codeDrop();
    open();
    await claimAs(a!.jar, d0.id, 'SUDO');
    expect(t.ctx.points.total(a!.id)).toBe(15);
    expect((await req(t.app, admin, 'POST', '/api/drops/admin/reset', { confirm: 'nope' })).statusCode).toBe(400);
    expect((await req(t.app, admin, 'POST', '/api/drops/admin/reset', { confirm: 'reset drops' })).statusCode).toBe(200);
    expect(t.ctx.points.total(a!.id)).toBe(0);
    expect(t.ctx.stickers.unlockedBy(a!.id)['drops-quickdraw']).toBeUndefined();
  });

  it('signs in through the real flow too', async () => {
    const [kit] = await makeKits(t.app, 1);
    const a = await signedInAttendee(t.app, kit!, 'realone');
    const d0 = await codeDrop();
    open();
    expect((await claimAs(a.jar, d0.id, 'SUDO')).body.outcome).toBe('won');
  });
});
