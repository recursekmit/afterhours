import { avatarFromSeed } from '@afterhours/shared';
import {
  type HuntAdmin,
  type HuntAdminProgress,
  type HuntAttemptResult,
  type HuntBoard,
  type HuntHintResult,
  type HuntMe,
  type HuntStickerSheet,
  HUNT_CONFIRM_RESET,
  extractHuntCode,
  normaliseAnswer,
} from '@afterhours/shared/features/hunt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newToken, sha256 } from '../../core/auth/crypto';
import { run } from '../../core';
import { type TestApp, Jar, adminJar, capture, makeApp, req } from '../../../test/helpers';
import { cooldownFor, rankBonus, speedBonus, stopOrder, stopWorth } from './rules';
import { hunt } from './index';
import { setVisibility } from './visibility';

const flushTick = async (t: TestApp) => {
  await hunt.tick!.run(t.ctx);
};

// ---- fast attendees: skip scrypt by inserting the kit, attendee and session directly ----
let kitSeq = 0;
function fastAttendee(t: TestApp, nickname: string) {
  const n = ++kitSeq;
  const kitId = `HT-${String(n).padStart(4, '0')}`;
  const now = t.ctx.now();
  run(t.ctx.db, 'INSERT INTO kits (id, password_hash, created_at) VALUES (?, ?, ?)', kitId, 'x', now);
  const id = run(
    t.ctx.db,
    `INSERT INTO attendees (kit_id, name, roll, nickname, avatar, profile_complete, first_signin_at, profile_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    kitId,
    `Person ${n}`,
    `23BD1A${String(n).padStart(4, '0')}`,
    nickname,
    JSON.stringify(avatarFromSeed(n)),
    now,
    now,
  ).lastId;
  const token = newToken();
  run(t.ctx.db, "INSERT INTO sessions (token_hash, kind, attendee_id, created_at, expires_at) VALUES (?, 'attendee', ?, ?, ?)", sha256(token), id, now, now + 86_400_000);
  const jar = new Jar();
  jar.cookies.ah_sid = token;
  return { id, jar };
}

type Who = ReturnType<typeof fastAttendee>;
const STOP_DEFS = [
  { title: 'alpha', clue: 'CLUE-ALPHA riddle', answers: ['Semi-Colon', 'semicolon!'], hints: ['HINT-A1', 'HINT-A2'], location: 'door' },
  { title: 'bravo', clue: 'CLUE-BRAVO riddle', answers: ['keyboard'], hints: ['HINT-B1'] },
  { title: 'charlie', clue: 'CLUE-CHARLIE riddle', answers: [], hints: [] }, // sticker only
  { title: 'delta', clue: 'CLUE-DELTA riddle', answers: ['42', 'forty two'], hints: ['HINT-D1', 'HINT-D2'] },
  { title: 'echo', clue: 'CLUE-ECHO riddle', answers: ['hello world'], hints: [], reveal: 'finale reveal' },
];

describe('hunt feature', () => {
  let t: TestApp;
  let admin: Jar;
  let stops: HuntAdmin['stops'];

  const api = async <T>(who: Jar | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
    const r = await req(t.app, who, method, `/api/hunt${url}`, body);
    return { status: r.statusCode, body: r.json() as T, raw: r.body };
  };
  const me = (w: Who) => api<HuntMe>(w.jar, 'GET', '');
  const start = (w: Who) => api<HuntMe>(w.jar, 'POST', '/start');
  const scan = (w: Who, code: string) => api<HuntAttemptResult>(w.jar, 'POST', '/scan', { code });
  const answer = (w: Who, stopId: number, text: string) => api<HuntAttemptResult>(w.jar, 'POST', '/answer', { stopId, answer: text });
  const byTitle = (title: string) => stops.find((s) => s.title === title)!;
  const refresh = async () => {
    stops = (await api<HuntAdmin>(admin, 'GET', '/admin')).body.stops;
  };
  async function setup(open = true) {
    for (const d of STOP_DEFS) {
      const r = await api<HuntAdmin>(admin, 'POST', '/admin/stops', d);
      expect(r.status).toBe(200);
    }
    await refresh();
    if (open) expect((await api<HuntAdmin>(admin, 'PUT', '/admin/state', { status: 'open' })).status).toBe(200);
  }
  /** Solve whatever the attendee's current stop is, via its QR, and return the result. */
  async function solveCurrent(w: Who) {
    const cur = (await me(w)).body.current!;
    const stop = stops.find((s) => s.id === cur.stopId)!;
    return scan(w, stop.token);
  }

  beforeEach(async () => {
    t = await makeApp();
    setVisibility(t.ctx, { hunt: true, morse: true }); // both events are hidden from players by default
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  // ---------- pure rules ----------

  describe('rules', () => {
    it('shuffled order is a deterministic permutation with the same finale for all', () => {
      const ids = [1, 2, 3, 4, 5, 6, 7, 8];
      const a = stopOrder('seed', 7, ids);
      expect(stopOrder('seed', 7, ids)).toEqual(a);
      expect([...a].sort((x, y) => x - y)).toEqual(ids);
      for (let who = 1; who <= 50; who++) expect(stopOrder('seed', who, ids).at(-1)).toBe(8);
      expect(stopOrder('other-seed', 7, ids)).not.toEqual(a);
      expect(stopOrder('seed', 8, ids)).not.toEqual(a);
      expect(stopOrder('s', 1, [])).toEqual([]);
      expect(stopOrder('s', 1, [9])).toEqual([9]);
    });

    it('spreads 300 attendees roughly evenly over the first stop', () => {
      const ids = [1, 2, 3, 4, 5, 6, 7];
      const firsts = new Map<number, number>();
      for (let who = 1; who <= 300; who++) {
        const f = stopOrder('spread', who, ids)[0]!;
        firsts.set(f, (firsts.get(f) ?? 0) + 1);
      }
      expect(firsts.has(7)).toBe(false); // the finale is never first
      expect(firsts.size).toBe(6);
      for (const n of firsts.values()) expect(n).toBeGreaterThan(30); // 50 expected
    });

    it('normalises typed answers', () => {
      expect(normaliseAnswer('  Hello,   WORLD! ')).toBe('helloworld');
      expect(normaliseAnswer('Café')).toBe('cafe');
      expect(normaliseAnswer(';')).toBe('');
      expect(normaliseAnswer('Forty-Two')).toBe('fortytwo');
    });

    it('extracts a code from a url, token or typed code', () => {
      expect(extractHuntCode('https://x.org/hunt/s/AbC_-123?utm=1#z')).toBe('AbC_-123');
      expect(extractHuntCode('  abcd-efgh ')).toBe('abcd-efgh');
    });

    it('escalates cooldowns, prices hints and bonuses', () => {
      expect([0, 1, 2, 3, 4, 5, 6, 40].map(cooldownFor)).toEqual([0, 3000, 8000, 20000, 45000, 90000, 120000, 120000]);
      expect([0, 1, 2].map((n) => stopWorth(10, n))).toEqual([10, 8, 5]);
      expect(stopWorth(3, 2)).toBe(1);
      expect([1, 2, 3, 10, 11, 25, 26].map(rankBonus)).toEqual([50, 35, 25, 10, 8, 8, 5]);
      expect([5, 15, 16, 25, 30, 41].map((m) => speedBonus(m * 60_000))).toEqual([20, 20, 12, 12, 6, 0]);
    });
  });

  // ---------- access and secrecy ----------

  describe('access', () => {
    it('needs the right session for every route', async () => {
      await setup();
      const a = fastAttendee(t, 'anna');
      expect((await api(null, 'GET', '')).status).toBe(401);
      expect((await api(null, 'POST', '/scan', { code: 'x' })).status).toBe(401);
      expect((await api(null, 'GET', '/board')).status).toBe(401);
      for (const [m, u] of [['GET', '/admin'], ['GET', '/admin/stickers'], ['GET', '/admin/progress'], ['PUT', '/admin/state'], ['POST', '/admin/stops'], ['PUT', '/admin/order'], ['POST', '/admin/reset']] as const) {
        expect((await api(a.jar, m, u, {})).status).toBe(401);
      }
      expect((await api(admin, 'GET', '/board')).status).toBe(200); // console previews the projector
    });

    it('shows nothing about stops until the hunt is open and the attendee has started', async () => {
      await setup(false);
      const a = fastAttendee(t, 'anna');
      const draft = await me(a);
      expect(draft.body.status).toBe('draft');
      expect(draft.body.current).toBeNull();
      expect(draft.raw).not.toContain('CLUE-');
      expect((await start(a)).status).toBe(409); // not open yet
      await api(admin, 'PUT', '/admin/state', { status: 'open' });
      const opened = await me(a);
      expect(opened.body.started).toBe(false);
      expect(opened.body.current).toBeNull();
      expect(opened.raw).not.toContain('CLUE-');
      expect((await scan(a, stops[0]!.token)).status).toBe(409); // must press start first
    });

    it('never sends answers, tokens, other clues or organiser notes to the attendee', async () => {
      await setup();
      const a = fastAttendee(t, 'anna');
      await start(a);
      const m = await me(a);
      const cur = m.body.current!;
      const bodies = [m.raw, (await api(a.jar, 'GET', '/board')).raw];
      const wrong = await answer(a, cur.stopId, 'definitely not');
      bodies.push(wrong.raw);
      const secrets = [...stops.flatMap((s) => [s.token, s.code, s.code.replace('-', ''), s.location, ...s.answers.map((x) => x.toLowerCase())]), 'HINT-'].filter((x) => x.length >= 5 && x !== 'door');
      const otherClues = stops.filter((s) => s.id !== cur.stopId).map((s) => s.clue);
      for (const b of bodies) {
        for (const s of secrets) expect(b.toLowerCase()).not.toContain(s.toLowerCase());
        for (const c of otherClues) expect(b).not.toContain(c);
      }
      expect(m.body.current!.hints).toEqual([]); // unrevealed hints are not sent
    });

    it('lets attendees see the live board but not console data', async () => {
      await setup();
      const a = fastAttendee(t, 'anna');
      const b = await api<HuntBoard>(a.jar, 'GET', '/board');
      expect(b.status).toBe(200);
      expect(b.body.finishers).toEqual([]);
      expect(b.raw).not.toContain('token');
    });
  });

  // ---------- solving ----------

  describe('solving', () => {
    it('walks the shuffled route and ends on the finale for everyone', async () => {
      await setup();
      const seen: number[][] = [];
      for (const nick of ['a1', 'a2', 'a3', 'a4']) {
        const w = fastAttendee(t, nick);
        await start(w);
        const route: number[] = [];
        for (let i = 0; i < stops.length; i++) {
          const cur = (await me(w)).body.current!;
          expect(cur.index).toBe(i + 1);
          route.push(cur.stopId);
          expect((await solveCurrent(w)).body.result).toBe('solved');
        }
        expect(route.at(-1)).toBe(byTitle('echo').id);
        expect((await me(w)).body.current).toBeNull();
        seen.push(route);
      }
      expect(new Set(seen.map((r) => r.join())).size).toBeGreaterThan(1); // not everyone walks the same way
    });

    it('solves by typed answer with case, spacing and punctuation tolerated and alternatives accepted', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      // Walk to each stop that has typed answers by solving others via QR as needed.
      const tries: Record<string, string> = { alpha: '  SEMI colon ', bravo: 'Key-Board', delta: 'Forty Two!', echo: 'HELLO,   world' };
      const solvedWith: string[] = [];
      for (let i = 0; i < stops.length; i++) {
        const cur = (await me(w)).body.current!;
        const stop = stops.find((s) => s.id === cur.stopId)!;
        const typed = tries[stop.title];
        if (!typed) {
          expect(cur.canType).toBe(false);
          expect((await answer(w, cur.stopId, 'anything')).status).toBe(400); // sticker only
          await scan(w, stop.token);
        } else {
          const r = (await answer(w, cur.stopId, typed)).body;
          expect(r.result).toBe('solved');
          solvedWith.push(stop.title);
        }
      }
      expect(solvedWith.sort()).toEqual(['alpha', 'bravo', 'delta', 'echo']);
    });

    it('scanning accepts the url, the bare token and the typed short code', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const forms = (s: HuntAdmin['stops'][number]) => [s.url, s.token, s.code.toLowerCase(), s.code.replace('-', ' ')];
      for (let i = 0; i < 3; i++) {
        const cur = (await me(w)).body.current!;
        const stop = stops.find((s) => s.id === cur.stopId)!;
        const r = (await scan(w, forms(stop)[i]!)).body;
        expect(r.result).toBe('solved');
      }
    });

    it("handles someone else's sticker kindly and identically to a garbage code", async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      const later = stops.find((s) => s.id !== cur.stopId && s.title !== 'echo')!;
      const finale = byTitle('echo');
      const a = (await scan(w, later.token)).body;
      const b = (await scan(w, 'x'.repeat(22))).body;
      const c = (await scan(w, finale.url)).body;
      for (const r of [a, b, c]) expect(r.result).toBe('not_yours');
      // Same words, and no hint about which stop it was.
      expect(a.message).toBe(b.message);
      expect(c.message).toBe(b.message);
      const strip = (x: HuntAttemptResult) => JSON.stringify({ ...x, me: { ...x.me, serverNow: 0, crowd: { ...x.me.crowd, updatedAt: 0 } } });
      expect(strip(a)).toBe(strip(b));
      expect(strip(c)).toBe(strip(b));
      expect((await me(w)).body.solved).toHaveLength(0); // nothing was skipped
      // The real one still works afterwards, and a repeat is "already".
      const here = stops.find((s) => s.id === cur.stopId)!;
      expect((await scan(w, here.token)).body.result).toBe('solved');
      const again = (await scan(w, here.token)).body;
      expect(again.result).toBe('already');
    });

    it('cannot answer or skip to a stop that is not current', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      const other = stops.find((s) => s.id !== cur.stopId && s.answers.length > 0)!;
      const r = (await answer(w, other.id, other.answers[0]!)).body;
      expect(r.result).toBe('not_yours');
      expect((await me(w)).body.solved).toHaveLength(0);
      expect((await answer(w, 99999, 'x')).body.result).toBe('not_yours');
    });

    it('pays once: replays and double submits do not pay twice', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      const stop = stops.find((s) => s.id === cur.stopId)!;
      const before = t.ctx.points.total(w.id);
      const results = await Promise.all([scan(w, stop.token), scan(w, stop.token), scan(w, stop.url)]);
      expect(results.filter((r) => r.body.result === 'solved')).toHaveLength(1);
      expect(t.ctx.points.total(w.id)).toBe(before + stop.points);
      expect(t.ctx.stickers.unlockedBy(w.id)['hunt-first-stamp']).toBeDefined();
      const ledger = t.ctx.points.history(w.id).filter((h) => h.source === 'hunt');
      expect(ledger).toHaveLength(1);
    });
  });

  // ---------- brute force and cooldowns ----------

  describe('wrong answers', () => {
    it('locks escalating cooldowns per stop and refuses attempts while locked', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      const stop = stops.find((s) => s.id === cur.stopId)!;
      if (stop.answers.length === 0) return; // charlie is sticker only; covered elsewhere
      const first = (await answer(w, cur.stopId, 'nope')).body;
      expect(first).toMatchObject({ result: 'wrong', wrongCount: 1, cooldownMs: 3000 });
      const locked = (await answer(w, cur.stopId, stop.answers[0]!)).body; // even the right answer waits
      expect(locked.result).toBe('locked');
      expect((await me(w)).body.current!.lockedUntil).toBeGreaterThan(t.ctx.now());
      t.clock.advance(3001);
      expect((await answer(w, cur.stopId, 'nope again')).body).toMatchObject({ result: 'wrong', wrongCount: 2, cooldownMs: 8000 });
      t.clock.advance(8001);
      expect((await answer(w, cur.stopId, 'still no')).body).toMatchObject({ wrongCount: 3, cooldownMs: 20000 });
      t.clock.advance(20_001);
      expect((await answer(w, cur.stopId, stop.answers[0]!)).body.result).toBe('solved');
    });

    it('scripted brute force gets almost nowhere', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      // Walk to a stop with typed answers (delta/alpha/bravo/echo); solve charlie by sticker if hit.
      let cur = (await me(w)).body.current!;
      while (stops.find((s) => s.id === cur.stopId)!.answers.length === 0) {
        await solveCurrent(w);
        cur = (await me(w)).body.current!;
      }
      let accepted = 0;
      let limited = 0;
      for (let i = 0; i < 300; i++) {
        t.clock.advance(100); // a bot trying 10 per second
        const r = await answer(w, cur.stopId, `guess${i}`);
        if (r.status === 429) limited++;
        else if (r.body.result === 'wrong') accepted++;
      }
      expect(accepted).toBeLessThanOrEqual(6); // 30 s of hammering: 3s then 8s then 20s locks
      const wrongCount = (await me(w)).body.current!.wrongCount;
      expect(wrongCount).toBe(accepted);
      void limited;
    });

    it('rate limits scan guessing for non matching codes', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      let limited = 0;
      for (let i = 0; i < 25; i++) if ((await scan(w, `guess-${i}`)).status === 429) limited++;
      expect(limited).toBe(15);
      t.clock.advance(60_000);
      expect((await scan(w, 'guess')).status).toBe(200);
    });

    it('rejects empty and oversized input', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      expect((await answer(w, cur.stopId, '   !!! ')).status).toBe(400);
      expect((await api(w.jar, 'POST', '/answer', { stopId: 'x', answer: 'a' })).status).toBe(400);
      expect((await api(w.jar, 'POST', '/answer', { stopId: cur.stopId, answer: 'a'.repeat(500) })).status).toBe(400);
      expect((await scan(w, '')).status).toBe(400);
    });
  });

  // ---------- hints ----------

  describe('hints', () => {
    async function onStopWithTwoHints(w: Who) {
      await start(w);
      let cur = (await me(w)).body.current!;
      while (stops.find((s) => s.id === cur.stopId)!.hints.length < 2) {
        await solveCurrent(w);
        cur = (await me(w)).body.current!;
      }
      return cur;
    }

    it('reveals one at a time, charges at solve, and never double charges', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      const cur = await onStopWithTwoHints(w);
      const stop = stops.find((s) => s.id === cur.stopId)!;
      expect(cur.hintsLeft).toBe(2);
      expect(cur.nextHintCost).toBe(2);
      expect(cur.worth).toBe(10);
      const hint = (n: number) => api<HuntHintResult>(w.jar, 'POST', '/hint', { stopId: cur.stopId, n });

      expect((await hint(2)).status).toBe(400); // cannot skip
      const h1 = await hint(1);
      expect(h1.body).toMatchObject({ n: 1, hint: stop.hints[0], cost: 2 });
      expect(h1.body.me.current).toMatchObject({ hints: [stop.hints[0]], hintsLeft: 1, nextHintCost: 3, worth: 8 });
      expect((await hint(1)).body.cost).toBe(0); // repeating is free
      const h2 = await hint(2);
      expect(h2.body).toMatchObject({ n: 2, cost: 3 });
      expect(h2.body.me.current).toMatchObject({ hintsLeft: 0, nextHintCost: null, worth: 5 });
      expect((await hint(3)).status).toBe(400); // schema caps at 2
      expect((await api(w.jar, 'POST', '/hint', { stopId: cur.stopId, n: 0 })).status).toBe(400);

      const before = t.ctx.points.total(w.id);
      const r = await scan(w, stop.token);
      expect(r.body.result).toBe('solved');
      expect(t.ctx.points.total(w.id) - before).toBe(5);
      if (r.body.result === 'solved') expect(r.body.stop).toMatchObject({ points: 5, hintsUsed: 2 });
    });

    it('refuses hints for a stop that is not current or has none', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      const other = stops.find((s) => s.id !== cur.stopId)!;
      expect((await api(w.jar, 'POST', '/hint', { stopId: other.id, n: 1 })).status).toBe(409);
      const noHints = stops.find((s) => s.hints.length === 0)!;
      const w2 = fastAttendee(t, 'bala');
      await start(w2);
      let c2 = (await me(w2)).body.current!;
      while (c2.stopId !== noHints.id) {
        await solveCurrent(w2);
        c2 = (await me(w2)).body.current!;
      }
      expect((await api(w2.jar, 'POST', '/hint', { stopId: noHints.id, n: 1 })).status).toBe(400);
    });

    it('hint reveals survive a reload and are per attendee', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      const cur = await onStopWithTwoHints(w);
      await api(w.jar, 'POST', '/hint', { stopId: cur.stopId, n: 1 });
      expect((await me(w)).body.current!.hints).toHaveLength(1);
    });
  });

  // ---------- open / close ----------

  describe('open and close', () => {
    it('refuses play before open and after close, keeps stamps, and can reopen', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      await solveCurrent(w);
      const live = t.ctx.live;
      const watcher = capture(t.ctx, { attendeeId: null, admin: false, screen: false });
      await api(admin, 'PUT', '/admin/state', { status: 'closed' });
      expect(watcher.events.filter((e) => e.type === 'hunt.state').map((e) => e.data)).toEqual([{ trailId: 1, status: 'closed', title: 'the after hours hunt', total: 5 }]);
      const closed = await me(w);
      expect(closed.body.status).toBe('closed');
      expect(closed.body.current).toBeNull();
      expect(closed.body.solved).toHaveLength(1);
      expect((await scan(w, stops[0]!.token)).status).toBe(409);
      expect((await answer(w, stops[0]!.id, 'x')).status).toBe(409);
      expect((await api(w.jar, 'POST', '/hint', { stopId: stops[0]!.id, n: 1 })).status).toBe(409);
      await api(admin, 'PUT', '/admin/state', { status: 'open' });
      expect((await me(w)).body.current).not.toBeNull();
      expect((await solveCurrent(w)).body.result).toBe('solved');
      watcher.unsub();
      void live;
    });

    it('does not open with fewer than two stops, nor go back to draft once people started', async () => {
      await api(admin, 'POST', '/admin/stops', STOP_DEFS[0]);
      expect((await api(admin, 'PUT', '/admin/state', { status: 'open' })).status).toBe(409);
      await api(admin, 'POST', '/admin/stops', STOP_DEFS[1]);
      await api(admin, 'PUT', '/admin/state', { status: 'open' });
      await start(fastAttendee(t, 'anna'));
      expect((await api(admin, 'PUT', '/admin/state', { status: 'draft' })).status).toBe(409);
      expect((await api(admin, 'PUT', '/admin/state', {})).status).toBe(400);
    });
  });

  // ---------- finishing ----------

  describe('finishing', () => {
    async function finishAll(w: Who) {
      await start(w);
      let last: HuntAttemptResult | undefined;
      for (let i = 0; i < stops.length; i++) last = (await solveCurrent(w)).body;
      return last!;
    }

    it('ranks by finish order, pays rank and speed bonuses once, unlocks stickers', async () => {
      await setup();
      const ws = [fastAttendee(t, 'one'), fastAttendee(t, 'two'), fastAttendee(t, 'three'), fastAttendee(t, 'four')];
      const screen = capture(t.ctx, { attendeeId: null, admin: false, screen: true });
      const everyone = capture(t.ctx, { attendeeId: null, admin: false, screen: false });
      const results: HuntAttemptResult[] = [];
      for (const w of ws) {
        t.clock.advance(60_000);
        results.push(await finishAll(w));
      }
      const ranks = results.map((r) => (r.result === 'solved' ? r.finish : null));
      expect(ranks.map((f) => f?.rank)).toEqual([1, 2, 3, 4]);
      expect(ranks.map((f) => f?.rankBonus)).toEqual([50, 35, 25, 20]);
      expect(ranks.map((f) => f?.speedBonus)).toEqual([20, 20, 20, 20]); // 0 min each: instant in fake time
      expect(ranks[0]!.usedNoHints).toBe(true);

      const hunt = (id: number) => t.ctx.points.history(id, 100).filter((h) => h.source === 'hunt');
      const first = hunt(ws[0]!.id);
      expect(first.find((h) => h.ref === 'finish-rank')?.points).toBe(50);
      expect(first.find((h) => h.ref === 'finish-speed')?.points).toBe(20);
      expect(first.filter((h) => h.ref.startsWith('stop:')).reduce((s, h) => s + h.points, 0)).toBe(stops.reduce((s, x) => s + x.points, 0));

      const stick = (id: number) => Object.keys(t.ctx.stickers.unlockedBy(id)).filter((s) => s.startsWith('hunt-')).sort();
      expect(stick(ws[0]!.id)).toEqual(['hunt-clean', 'hunt-finisher', 'hunt-first-stamp', 'hunt-podium']);
      expect(stick(ws[3]!.id)).toEqual(['hunt-clean', 'hunt-finisher', 'hunt-first-stamp']);

      // Live moment: everyone hears each finish, in order; the projector also gets the stamp ticker.
      const fins = everyone.events.filter((e) => e.type === 'hunt.finished').map((e) => e.data as { finisher: { rank: number; nickname: string } });
      expect(fins.map((f) => f.finisher.rank)).toEqual([1, 2, 3, 4]);
      expect(fins[0]!.finisher.nickname).toBe('one');
      expect(screen.events.filter((e) => e.type === 'hunt.stamp')).toHaveLength(20);
      expect(everyone.types()).not.toContain('hunt.stamp');

      const board = (await api<HuntBoard>(ws[0]!.jar, 'GET', '/board')).body;
      expect(board.finishers.map((f) => f.nickname)).toEqual(['one', 'two', 'three', 'four']);
      expect(board.crowd).toMatchObject({ finished: 4, hunting: 0, players: 4 });
      screen.unsub();
      everyone.unsub();
    });

    it('slow finishers get no speed bonus and a hint costs the no-peeking sticker', async () => {
      await setup();
      const w = fastAttendee(t, 'slowpoke');
      await start(w);
      let hinted = false;
      for (let i = 0; i < stops.length; i++) {
        t.clock.advance(15 * 60_000);
        const cur = (await me(w)).body.current!;
        if (!hinted && cur.hintsLeft > 0) {
          await api(w.jar, 'POST', '/hint', { stopId: cur.stopId, n: 1 });
          hinted = true;
        }
        await solveCurrent(w);
      }
      const m = (await me(w)).body;
      expect(m.finish?.speedBonus).toBe(0);
      expect(m.finish?.usedNoHints).toBe(false);
      expect(t.ctx.stickers.unlockedBy(w.id)['hunt-clean']).toBeUndefined();
      expect(t.ctx.points.history(w.id, 100).some((h) => h.ref === 'finish-speed')).toBe(false);
    });

    it('a finished attendee cannot be paid again', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await finishAll(w);
      const total = t.ctx.points.total(w.id);
      expect((await scan(w, stops[0]!.token)).body.result).toBe('already');
      expect((await answer(w, stops[0]!.id, 'semicolon')).body.result).toBe('already');
      expect(t.ctx.points.total(w.id)).toBe(total);
    });
  });

  // ---------- crowd ----------

  describe('crowd', () => {
    it('counts people per stop anonymously and broadcasts on the tick only when something moved', async () => {
      await setup();
      const watcher = capture(t.ctx, { attendeeId: null, admin: false, screen: false });
      const people = Array.from({ length: 6 }, (_, i) => fastAttendee(t, `p${i}`));
      for (const p of people) await start(p);
      await flushTick(t);
      await flushTick(t); // nothing moved: no second broadcast
      const crowds = watcher.events.filter((e) => e.type === 'hunt.crowd');
      expect(crowds).toHaveLength(1);
      const c = crowds[0]!.data as { here: { stopId: number; count: number }[]; hunting: number; players: number };
      expect(c.hunting).toBe(6);
      expect(c.here.reduce((s, h) => s + h.count, 0)).toBe(6);
      expect(JSON.stringify(c)).not.toMatch(/nickname|attendee/i);
      // Each phone sees how many OTHERS share its stop.
      for (const p of people) {
        const m = (await me(p)).body;
        const mine = c.here.find((h) => h.stopId === m.current!.stopId)!;
        expect(m.current!.hereNow).toBe(mine.count - 1);
      }
      await solveCurrent(people[0]!);
      await flushTick(t);
      expect(watcher.events.filter((e) => e.type === 'hunt.crowd')).toHaveLength(2);
      const p0 = (await me(people[0]!)).body;
      expect(p0.solved[0]!.solvedBy).toBe(1);
      watcher.unsub();
    });
  });

  // ---------- console ----------

  describe('console', () => {
    it('validates stops and rejects answers that cannot match', async () => {
      const bad = (body: unknown) => api(admin, 'POST', '/admin/stops', body).then((r) => r.status);
      expect(await bad({ title: '', clue: 'x' })).toBe(400);
      expect(await bad({ title: 'x', clue: 'y', hints: ['1', '2', '3'] })).toBe(400);
      expect(await bad({ title: 'x', clue: 'y', answers: [';'] })).toBe(400);
      expect(await bad({ title: 'x', clue: 'y', clueImage: 'javascript:alert(1)' })).toBe(400);
      expect(await bad({ title: 'x', clue: 'y', points: 0 })).toBe(400);
      expect(await bad({ title: 'x', clue: 'y', glyph: 'poop' })).toBe(400);
      expect(await bad({ title: 'x', clue: 'y', clueImage: 'https://example.org/a.png', answers: ['Ok', 'ok!'] })).toBe(200);
      const r = await api<HuntAdmin>(admin, 'GET', '/admin');
      expect(r.body.stops[0]!.answers).toEqual(['Ok']); // duplicates after normalising dropped
    });

    it('prints a sticker sheet with unguessable, distinct tokens', async () => {
      await setup();
      const sheet = (await api<HuntStickerSheet>(admin, 'GET', '/admin/stickers')).body;
      expect(sheet.stops).toHaveLength(5);
      const tokens = sheet.stops.map((s) => s.token);
      expect(new Set(tokens).size).toBe(5);
      for (const s of sheet.stops) {
        expect(s.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(s.url).toBe(`${t.ctx.config.appUrl}/hunt/s/${s.token}`);
        expect(s.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
        for (const other of tokens.filter((x) => x !== s.token)) expect(s.url).not.toContain(other);
      }
      expect(sheet.stops[0]!.location).toBe('door');
    });

    it('rotating a token kills the old sticker', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const cur = (await me(w)).body.current!;
      const stop = stops.find((s) => s.id === cur.stopId)!;
      await api(admin, 'POST', `/admin/stops/${stop.id}/rotate-token`);
      expect((await scan(w, stop.token)).body.result).toBe('not_yours');
      await refresh();
      const fresh = stops.find((s) => s.id === stop.id)!;
      expect(fresh.token).not.toBe(stop.token);
      expect((await scan(w, fresh.token)).body.result).toBe('solved');
    });

    it('edits wording any time but locks structure once people started', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      const s = byTitle('bravo');
      const edit = await api<HuntAdmin>(admin, 'PUT', `/admin/stops/${s.id}`, { title: 'bravo', clue: 'CLUE-BRAVO v2', answers: ['keyboard'] });
      expect(edit.status).toBe(200);
      expect(edit.body.structureLocked).toBe(true);
      expect((await api(admin, 'POST', '/admin/stops', STOP_DEFS[0])).status).toBe(409);
      expect((await api(admin, 'DELETE', `/admin/stops/${s.id}`)).status).toBe(409);
      expect((await api(admin, 'PUT', '/admin/order', { ids: stops.map((x) => x.id).reverse() })).status).toBe(409);
      expect((await api(admin, 'PUT', '/admin/stops/9999', { title: 'x', clue: 'y' })).status).toBe(404);
    });

    it('reorders (last is the finale), deletes and repacks while nobody has started', async () => {
      await setup(false);
      const ids = stops.map((s) => s.id);
      expect((await api(admin, 'PUT', '/admin/order', { ids: ids.slice(1) })).status).toBe(400);
      expect((await api(admin, 'PUT', '/admin/order', { ids: [...ids.slice(0, 4), ids[0]] })).status).toBe(400);
      const re = await api<HuntAdmin>(admin, 'PUT', '/admin/order', { ids: [...ids].reverse() });
      expect(re.body.stops.map((s) => s.id)).toEqual([...ids].reverse());
      expect(re.body.stops.at(-1)!.isFinal).toBe(true);
      const del = await api<HuntAdmin>(admin, 'DELETE', `/admin/stops/${ids[0]}`);
      expect(del.body.stops.map((s) => s.position)).toEqual([1, 2, 3, 4]);
      expect((await api(admin, 'DELETE', `/admin/stops/${ids[0]}`)).status).toBe(404);
    });

    it('reports live progress per attendee and where the crowd is', async () => {
      await setup();
      const a = fastAttendee(t, 'anna');
      const b = fastAttendee(t, 'bala');
      await start(a);
      await start(b);
      await solveCurrent(a);
      t.clock.advance(5000);
      const p = (await api<HuntAdminProgress>(admin, 'GET', '/admin/progress')).body;
      expect(p.total).toBe(5);
      expect(p.rows).toHaveLength(2);
      const ra = p.rows.find((r) => r.nickname === 'anna')!;
      expect(ra).toMatchObject({ solved: 1, finishedAt: null, rank: null });
      expect(ra.currentStopTitle).toBeTruthy();
      expect(p.rows.find((r) => r.nickname === 'bala')).toMatchObject({ solved: 0 });
      expect(p.crowd.reduce((s, c) => s + c.count, 0)).toBe(2);
    });

    it('reset wipes progress, hunt points and stickers but keeps stops', async () => {
      await setup();
      const w = fastAttendee(t, 'anna');
      await start(w);
      await solveCurrent(w);
      expect(t.ctx.points.total(w.id)).toBeGreaterThan(0);
      expect((await api(admin, 'POST', '/admin/reset', { confirm: 'yes' })).status).toBe(400);
      const r = await api<HuntAdmin>(admin, 'POST', '/admin/reset', { confirm: HUNT_CONFIRM_RESET });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'draft', players: 0, structureLocked: false });
      expect(r.body.stops).toHaveLength(5);
      expect(t.ctx.points.total(w.id)).toBe(0);
      expect(t.ctx.stickers.unlockedBy(w.id)['hunt-first-stamp']).toBeUndefined();
      expect((await me(w)).body.solved).toEqual([]);
    });
  });

  // ---------- scale ----------

  it('handles 300 attendees walking the whole hunt without slowing down', async () => {
    await setup();
    const people = Array.from({ length: 300 }, (_, i) => fastAttendee(t, `n${i}`));
    const t0 = performance.now();
    // Round robin so everyone is on the hot path at once.
    await Promise.all(people.map((p) => start(p)));
    for (let round = 0; round < stops.length; round++) {
      await Promise.all(
        people.map(async (p) => {
          const cur = (await me(p)).body.current!;
          const stop = stops.find((s) => s.id === cur.stopId)!;
          const r = await scan(p, stop.token);
          expect(r.body.result).toBe('solved');
        }),
      );
      await flushTick(t);
      await api(people[0]!.jar, 'GET', '/board');
    }
    const ms = performance.now() - t0;
    const board = (await api<HuntBoard>(people[0]!.jar, 'GET', '/board')).body;
    expect(board.crowd.finished).toBe(300);
    expect(board.finishers).toHaveLength(50); // capped list
    expect(board.finishers.map((f) => f.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set((await api<HuntAdminProgress>(admin, 'GET', '/admin/progress')).body.rows.map((r) => r.rank)).size).toBe(300); // unique ranks
    expect(ms).toBeLessThan(15_000);
  });

  it('seeds a believable demo hunt', async () => {
    const { seedHunt } = await import('./seed');
    // a few profiled attendees so the demo crowd has someone to be
    for (let i = 0; i < 6; i++) fastAttendee(t, `demo${i}`);
    seedHunt(t.ctx);
    seedHunt(t.ctx); // idempotent
    const r = (await api<HuntAdmin>(admin, 'GET', '/admin')).body;
    expect(r.status).toBe('open');
    expect(r.stops.length).toBeGreaterThanOrEqual(6);
    expect(r.stops.length).toBeLessThanOrEqual(8);
    for (const s of r.stops) expect(s.hints.length).toBeGreaterThan(0);
    expect(r.stops.at(-1)!.isFinal).toBe(true);
  });
});
