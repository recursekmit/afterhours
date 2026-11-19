import { POLL_LIMITS } from '@afterhours/shared/features/polls';
import {
  PERSONALITY_TIE_ORDER,
  type PersonalityInput,
  type Recap,
  type RecapStatus,
  type RoomRecap,
  type StickerRarity,
  derivePersonality,
  rarityPct,
  stickerCategory,
} from '@afterhours/shared/features/recap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES, createSession } from '../../core/auth/sessions';
import { Jar, type TestApp, adminJar, capture, makeApp, req } from '../../../test/helpers';
import { tick as leaderboardTick } from '../leaderboard';
import { RECAP_STICKERS, SLAP_HAPPY_AT, tick as recapTick } from './index';
import { CACHE_MS, quizSpeedTable, wayOf } from './service';

interface Person {
  jar: Jar;
  id: number;
}

const AVATAR = JSON.stringify({ shape: 'blob', color: 'lime', eyes: 'wide', mouth: 'grin', top: 'cap', extra: 'none' });

/** Attendees straight in the database (hashing 300 kit passwords would take a minute). */
function people(t: TestApp, n: number, startMs = t.clock.now()): Person[] {
  const out: Person[] = [];
  const db = t.ctx.db;
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const kit = `T-${String(i).padStart(4, '0')}`;
    db.prepare('INSERT INTO kits (id, password_hash, created_at) VALUES (?, ?, ?)').run(kit, 'x', startMs);
    const r = db
      .prepare('INSERT INTO attendees (kit_id, name, nickname, avatar, profile_complete, first_signin_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(kit, `Person ${i}`, `nick${i}`, AVATAR, startMs + i * 60_000);
    const id = Number(r.lastInsertRowid);
    const jar = new Jar();
    jar.cookies[COOKIES.attendee] = createSession(t.ctx, 'attendee', id).token;
    out.push({ jar, id });
  }
  db.exec('COMMIT');
  t.ctx.points.invalidate();
  return out;
}

const blank: PersonalityInput = {
  morseLevels: 0,
  morseStamps: 0,
  huntStamps: 0,
  checkins: 0,
  arcadeGames: 0,
  arcadeLevels: 0,
  quizCorrect: 0,
  quizFasterThan: null,
  votes: 0,
  reactions: 0,
};

describe('recap: personality', () => {
  it('picks what you did most', () => {
    expect(derivePersonality({ ...blank, morseLevels: 4 }).id).toBe('decoder');
    expect(derivePersonality({ ...blank, huntStamps: 3, checkins: 1 }).id).toBe('explorer');
    expect(derivePersonality({ ...blank, arcadeGames: 3, quizFasterThan: 90 }).id).toBe('speedrunner');
    expect(derivePersonality({ ...blank, votes: 9, reactions: 40 }).id).toBe('crowd-pleaser');
    expect(derivePersonality({ ...blank, votes: 9, morseLevels: 2 })).toMatchObject({ id: 'crowd-pleaser', runnerUp: 'decoder' });
  });

  it('is deterministic and breaks ties by the fixed order', () => {
    // decoder 6 vs explorer 6 vs crowd-pleaser 6: decoder comes first in the tie order
    const tie = { ...blank, morseLevels: 2, huntStamps: 2, votes: 3 };
    const first = derivePersonality(tie);
    for (let i = 0; i < 20; i++) expect(derivePersonality({ ...tie })).toEqual(first);
    expect(first).toMatchObject({ id: 'decoder', runnerUp: 'explorer' });
    // explorer 6 vs crowd-pleaser 6: explorer wins
    expect(derivePersonality({ ...blank, huntStamps: 2, votes: 3 })).toMatchObject({ id: 'explorer', runnerUp: 'crowd-pleaser' });
    expect(PERSONALITY_TIE_ORDER[0]).toBe('decoder');
  });

  it('nothing at all is the mystery guest', () => {
    expect(derivePersonality(blank)).toMatchObject({ id: 'mystery', runnerUp: null });
    // 4 reactions round down to zero crowd-pleaser points: still a mystery
    expect(derivePersonality({ ...blank, reactions: 4 }).id).toBe('mystery');
  });
});

describe('recap: helpers', () => {
  it('names the way you went', () => {
    expect(wayOf('slip 2: the lab path')).toBe('lab');
    expect(wayOf('slip 2: the stage path')).toBe('stage');
    expect(wayOf('the library')).toBe('library');
    expect(wayOf('Canteen')).toBe('canteen');
  });

  it('quiz speed: share of the room slower than you, over your correct answers', () => {
    const rows = [
      // poll 1: a fastest (2 slower of 2 others), b middle, c slowest
      { poll_id: 1, attendee_id: 1, correct: 1, elapsed_ms: 1000 },
      { poll_id: 1, attendee_id: 2, correct: 1, elapsed_ms: 2000 },
      { poll_id: 1, attendee_id: 3, correct: 0, elapsed_ms: 3000 },
      // poll 2: only one person, does not count
      { poll_id: 2, attendee_id: 3, correct: 1, elapsed_ms: 500 },
    ];
    const t = quizSpeedTable(rows);
    expect(t.get(1)).toBe(100);
    expect(t.get(2)).toBe(50);
    expect(t.get(3)).toBe(0); // no correct answers that count: falls back to all answers
  });

  it('sorts stickers into book pages', () => {
    expect(stickerCategory({ id: 'showed-up', feature: 'core' })).toBe('attendance');
    expect(stickerCategory({ id: 'hunt-finisher', feature: 'hunt' })).toBe('trails');
    expect(stickerCategory({ id: 'morse-speedy', feature: 'morse' })).toBe('morse');
    expect(stickerCategory({ id: 'reactions-hype', feature: 'reactions' })).toBe('secret');
    expect(stickerCategory({ id: 'whatever', feature: 'brand-new' })).toBe('secret');
  });
});

describe('recap feature', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  const status = async (jar: Jar | null) => (await req(t.app, jar, 'GET', '/api/recap/status')).json() as RecapStatus;
  const open = (v: boolean) => req(t.app, admin, 'POST', '/api/recap/admin/open', { open: v });

  describe('gating', () => {
    it('is locked until the console opens it, then closes again', async () => {
      const [a] = people(t, 1);
      expect((await req(t.app, a!.jar, 'GET', '/api/recap/me')).statusCode).toBe(403);
      expect((await req(t.app, a!.jar, 'GET', '/api/recap/me')).json()).toMatchObject({ error: { code: 'recap_locked' } });
      expect((await req(t.app, a!.jar, 'POST', '/api/recap/admin/open', { open: true })).statusCode).toBe(401);
      expect(await status(a!.jar)).toMatchObject({ open: false, reason: null });

      const phone = capture(t.ctx, { attendeeId: a!.id, admin: false, screen: false });
      expect((await open(true)).json()).toMatchObject({ open: true, reason: 'console', consoleOpen: true });
      expect(phone.events.find((e) => e.type === 'recap.status')?.data).toMatchObject({ open: true });
      expect((await req(t.app, a!.jar, 'GET', '/api/recap/me')).statusCode).toBe(200);

      expect((await open(false)).json()).toMatchObject({ open: false });
      expect((await req(t.app, a!.jar, 'GET', '/api/recap/me')).statusCode).toBe(403);
      phone.unsub();
    });

    it('opens by itself when the final reveal is done, and stays open after an unfreeze', async () => {
      const ppl = people(t, 3);
      ppl.forEach((p, i) => t.ctx.points.award({ attendeeId: p.id, source: 'test', ref: 'x', points: 10 + i, label: 'test' }));
      expect((await req(t.app, admin, 'POST', '/api/leaderboard/admin/freeze', { topN: 3, stepMs: 1000, suspenseMs: 0 })).statusCode).toBe(200);
      expect(await status(admin)).toMatchObject({ open: false, closing: true });
      await req(t.app, admin, 'POST', '/api/leaderboard/admin/reveal', {});
      expect((await status(admin)).open).toBe(false); // first place not out yet
      t.clock.advance(5000);
      leaderboardTick(t.ctx);
      const screen = capture(t.ctx, { attendeeId: null, admin: false, screen: true });
      recapTick(t.ctx);
      expect(screen.events.find((e) => e.type === 'recap.status')?.data).toMatchObject({ open: true, reason: 'reveal', revealDone: true });
      recapTick(t.ctx); // nothing changed: no second event
      expect(screen.events.filter((e) => e.type === 'recap.status')).toHaveLength(1);
      screen.unsub();

      await req(t.app, admin, 'POST', '/api/leaderboard/admin/unfreeze', {});
      expect(await status(admin)).toMatchObject({ open: true, reason: 'reveal', revealDone: false });
      expect((await req(t.app, ppl[0]!.jar, 'GET', '/api/recap/me')).statusCode).toBe(200);

      // the console can still close it, and the same reveal does not reopen it
      await open(false);
      expect((await status(admin)).open).toBe(false);
      recapTick(t.ctx);
      expect((await status(admin)).open).toBe(false);
    });
  });

  describe('aggregation', () => {
    it('builds a seeded attendee across every feature', async () => {
      const start = t.clock.now();
      const [me, other, third] = people(t, 3, start - 3 * 60_000);
      const db = t.ctx.db;

      // attendance: two check-ins through the real console route
      for (const title of ['opening jam', 'what happens when you type a url']) {
        const st = (await req(t.app, admin, 'POST', '/api/schedule', { title, startAt: start, endAt: start + 3_600_000 })).json() as { activities: { id: number; title: string }[] };
        const id = String(st.activities.find((x) => x.title === title)!.id);
        const o = await req(t.app, admin, 'POST', '/api/attendance/admin/open', { activityId: id });
        expect(o.statusCode, o.body).toBe(200);
        expect((await req(t.app, admin, 'POST', `/api/attendance/admin/activity/${id}/checkin`, { attendeeId: me!.id })).statusCode).toBe(200);
      }

      // polls: one regular vote, one quiz where I am right and fastest
      const single = (await req(t.app, admin, 'POST', '/api/polls/admin', { kind: 'single', question: 'best snack?', options: [{ label: 'samosa' }, { label: 'maggi' }] })).json() as {
        poll: { id: number };
      };
      await req(t.app, admin, 'POST', `/api/polls/admin/${single.poll.id}/launch`, { closeCurrent: true });
      expect((await req(t.app, me!.jar, 'POST', `/api/polls/${single.poll.id}/vote`, { kind: 'single', choice: 0 })).statusCode).toBe(200);
      await req(t.app, admin, 'POST', `/api/polls/admin/${single.poll.id}/close`);
      const quiz = (
        await req(t.app, admin, 'POST', '/api/polls/admin', {
          kind: 'quiz',
          question: 'which is a port?',
          options: [{ label: '443' }, { label: 'cat' }, { label: 'dog' }, { label: 'bird' }],
          correct: 0,
          durationMs: 20_000,
          basePoints: 20,
          speedBonusMax: 20,
          series: 's1',
        })
      ).json() as { poll: { id: number } };
      await req(t.app, admin, 'POST', `/api/polls/admin/${quiz.poll.id}/launch`, { closeCurrent: true });
      t.clock.advance(POLL_LIMITS.quizLeadInMs + 2000);
      expect((await req(t.app, me!.jar, 'POST', `/api/polls/${quiz.poll.id}/vote`, { kind: 'quiz', choice: 0 })).statusCode).toBe(200);
      t.clock.advance(3000);
      await req(t.app, other!.jar, 'POST', `/api/polls/${quiz.poll.id}/vote`, { kind: 'quiz', choice: 0 });
      t.clock.advance(3000);
      await req(t.app, third!.jar, 'POST', `/api/polls/${quiz.poll.id}/vote`, { kind: 'quiz', choice: 2 });
      await req(t.app, admin, 'POST', `/api/polls/admin/${quiz.poll.id}/close`);
      expect((await req(t.app, admin, 'POST', `/api/polls/admin/${quiz.poll.id}/reveal`)).statusCode).toBe(200);

      // trails: a graph trail where I took the lab path, plus a morse trail stamp (read-only fixtures)
      const now = t.clock.now();
      const trail = (title: string, kind: string, mode: string) =>
        Number(db.prepare("INSERT INTO hunt_trails (position, kind, title, status, order_mode, shuffle_seed) VALUES (9, ?, ?, 'open', ?, 'x')").run(kind, title, mode).lastInsertRowid);
      let n = 0;
      const stop = (trailId: number, title: string, finale = 0) =>
        Number(
          db
            .prepare("INSERT INTO hunt_stops (trail_id, position, title, clue, token, code, is_finale, challenge) VALUES (?, ?, ?, 'c', ?, ?, ?, 'riddle')")
            .run(trailId, ++n, title, `tok${n}`, `CODE${n}`, finale).lastInsertRowid,
        );
      const slipTrail = trail('the slip trail', 'morse', 'graph');
      const s1 = stop(slipTrail, 'slip 1: the start');
      const s2 = stop(slipTrail, 'slip 2: the lab path');
      stop(slipTrail, 'slip 2: the stage path');
      const s4 = stop(slipTrail, 'the last word', 1);
      const hunt = trail('the after hours hunt', 'hunt', 'shuffled');
      const h1 = stop(hunt, 'the semicolon');
      stop(hunt, 'the cache');
      const solve = (stopId: number, at: number) =>
        db.prepare("INSERT INTO hunt_progress (attendee_id, stop_id, solved_at, via, points) VALUES (?, ?, ?, 'answer', 10)").run(me!.id, stopId, at);
      solve(s1, now + 1);
      solve(s2, now + 2);
      solve(s4, now + 3);
      solve(h1, now + 4);
      db.prepare('INSERT INTO hunt_players (trail_id, attendee_id, started_at, last_at, finished_at) VALUES (?, ?, ?, ?, ?)').run(slipTrail, me!.id, now, now, now + 3);
      t.ctx.points.award({ attendeeId: me!.id, source: 'hunt', ref: 'slip:7', points: 10, label: 'slip bonus: slip 2' });

      // morse: two decode levels and one encode, best 14.2 wpm
      const best = db.prepare('INSERT INTO morse_best (attendee_id, mode, level, best_score, best_wpm, attempts, first_clear_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
      best.run(me!.id, 'decode', 1, 80, 9.5, now);
      best.run(me!.id, 'decode', 2, 70, 14.2, now);
      best.run(me!.id, 'encode', 1, 60, 11, now);
      best.run(me!.id, 'encode', 2, 0, null, now); // tried, never cleared

      // arcade: two bests (I am #1 in lag spike of 2) and a cracked puzzle-hour level, plus the biggest award
      const ab = db.prepare('INSERT INTO arcade_best (attendee_id, game, score, label, at) VALUES (?, ?, ?, ?, ?)');
      ab.run(me!.id, 'reaction', 800, '200 ms', now);
      ab.run(other!.id, 'reaction', 700, '300 ms', now);
      ab.run(me!.id, 'memory', 500, 'level 5', now);
      t.ctx.points.award({ attendeeId: me!.id, source: 'arcade-rounds.packet', ref: 'level:p1', points: 60, label: 'packet one: cracked' });

      // reactions through the real route, stickers through core
      for (let i = 0; i < 6; i++) {
        t.clock.advance(700);
        await req(t.app, me!.jar, 'POST', '/api/reactions', { kind: 'fire' });
      }
      t.ctx.stickers.unlock(me!.id, 'showed-up');
      t.ctx.stickers.unlock(other!.id, 'showed-up');
      t.ctx.stickers.unlock(third!.id, 'showed-up');
      t.ctx.stickers.unlock(me!.id, 'morse-decoder');

      await open(true);
      const r = await req(t.app, me!.jar, 'GET', '/api/recap/me');
      expect(r.statusCode, r.body).toBe(200);
      const recap = r.json() as Recap;

      expect(recap.attendee).toMatchObject({ id: me!.id, nickname: 'nick0' });
      expect(recap.arrival).toMatchObject({ at: start - 3 * 60_000, order: 1, of: 3 });
      expect(recap.sessions).toEqual({ count: 2, titles: ['opening jam', 'what happens when you type a url'] });
      expect(recap.polls.votes).toBe(2);
      expect(recap.polls.quiz).toMatchObject({ answered: 1, correct: 1, rank: 1, players: 2, fasterThan: 100 });
      expect(recap.polls.quiz.points).toBeGreaterThan(20);

      expect(recap.trails.stamps).toBe(4);
      expect(recap.trails.bonuses).toBe(1);
      const slip = recap.trails.list.find((x) => x.title === 'the slip trail');
      expect(slip).toMatchObject({ graph: true, finished: true, stamps: 3, stops: 4, way: 'lab', path: ['slip 1: the start', 'slip 2: the lab path', 'the last word'] });
      expect(recap.trails.list.find((x) => x.title === 'the after hours hunt')).toMatchObject({ graph: false, stamps: 1, stops: 2, way: null, finished: false });

      expect(recap.morse).toEqual({ levels: 3, decodeLevels: 2, encodeLevels: 1, bestWpm: 14.2, trailStamps: 3 });
      expect(recap.arcade.levelsCleared).toBe(1);
      expect(recap.arcade.bests).toEqual([
        { game: 'memory', title: 'echo', label: 'level 5', rank: 1, players: 1 },
        { game: 'reaction', title: 'lag spike', label: '200 ms', rank: 1, players: 2 },
      ]);
      expect(recap.reactions).toBe(6);

      // stickers: check-ins and votes unlock their own, plus the ones above; rarest is the morse one (1 of 3)
      expect(recap.stickers.count).toBeGreaterThanOrEqual(4);
      expect(recap.stickers.total).toBe(t.ctx.stickers.list().length);
      expect(recap.stickers.rarest?.pct).toBeLessThanOrEqual(34);
      expect(recap.stickers.recent.length).toBeGreaterThan(0);

      expect(recap.topMoment).toMatchObject({ points: 60, label: 'packet one: cracked', source: 'arcade-rounds.packet' });
      expect(recap.standing).toMatchObject({ rank: 1, players: 3 });
      expect(recap.standing.total).toBe(t.ctx.points.total(me!.id));
      // morse 3 levels + 3 morse stamps = 18 beats explorer (1 hunt stamp + 2 check-ins = 7)
      expect(recap.personality).toMatchObject({ id: 'decoder' });

      // the console can preview anyone; the room adds it all up
      const preview = (await req(t.app, admin, 'GET', `/api/recap/admin/attendee/${other!.id}`)).json() as Recap;
      expect(preview.attendee.nickname).toBe('nick1');
      expect((await req(t.app, me!.jar, 'GET', `/api/recap/admin/attendee/${other!.id}`)).statusCode).toBe(401);
      const room = (await req(t.app, admin, 'GET', '/api/recap/room')).json() as RoomRecap;
      expect(room).toMatchObject({ attendees: 3, stamps: 4, votes: 4, reactions: 6, checkins: 2 });
      expect(room.rarest?.count).toBe(1);
      expect(room.rarest?.holders.length).toBe(1);
      expect((await req(t.app, me!.jar, 'GET', '/api/recap/room')).statusCode).toBe(401);
      const list = (await req(t.app, admin, 'GET', '/api/recap/admin/attendees?q=nick1')).json() as { attendees: { id: number }[] };
      expect(list.attendees.map((x) => x.id)).toEqual([other!.id]);
    });

    it('a brand-new attendee gets an empty but valid recap', async () => {
      const [a] = people(t, 1);
      await open(true);
      const r = (await req(t.app, a!.jar, 'GET', '/api/recap/me')).json() as Recap;
      expect(r.personality.id).toBe('mystery');
      expect(r.trails).toEqual({ stamps: 0, bonuses: 0, list: [] });
      expect(r.topMoment).toBeNull();
      expect(r.standing.rank).toBeNull();
    });
  });

  describe('rarity', () => {
    it('counts holders per sticker and turns them into a share of attendees', async () => {
      const ppl = people(t, 8);
      ppl.forEach((p) => t.ctx.stickers.unlock(p.id, 'showed-up'));
      ppl.slice(0, 2).forEach((p) => t.ctx.stickers.unlock(p.id, 'new-face'));
      t.ctx.stickers.unlock(ppl[0]!.id, 'reactions-hype');
      const r = (await req(t.app, ppl[3]!.jar, 'GET', '/api/recap/rarity')).json() as StickerRarity;
      expect(r.attendees).toBe(8);
      expect(r.counts).toMatchObject({ 'showed-up': 8, 'new-face': 2, 'reactions-hype': 1 });
      expect(rarityPct(r, 'showed-up')).toBe(100);
      expect(rarityPct(r, 'new-face')).toBe(25);
      expect(rarityPct(r, 'reactions-hype')).toBe(13);
      expect(rarityPct(r, 'nobody-has-this')).toBe(0);
      expect(rarityPct({ attendees: 300, counts: { x: 2 } }, 'x')).toBe(0.7);
      expect(rarityPct({ attendees: 0, counts: {} }, 'x')).toBe(0);
      expect((await req(t.app, null, 'GET', '/api/recap/rarity')).statusCode).toBe(401);

      // cached for a few seconds, then live again
      t.ctx.stickers.unlock(ppl[1]!.id, 'reactions-hype');
      expect(((await req(t.app, ppl[3]!.jar, 'GET', '/api/recap/rarity')).json() as StickerRarity).counts['reactions-hype']).toBe(1);
      t.clock.advance(CACHE_MS + 1);
      expect(((await req(t.app, ppl[3]!.jar, 'GET', '/api/recap/rarity')).json() as StickerRarity).counts['reactions-hype']).toBe(2);
    });
  });

  describe('secret stickers', () => {
    it('watching, sharing and slapping unlock the recap stickers', async () => {
      const [a] = people(t, 1);
      expect((await req(t.app, a!.jar, 'POST', '/api/recap/me/seen', { cards: 11 })).statusCode).toBe(403);
      await open(true);
      await req(t.app, a!.jar, 'POST', '/api/recap/me/seen', { cards: 11 });
      await req(t.app, a!.jar, 'POST', '/api/recap/me/shared');
      expect(((await req(t.app, a!.jar, 'POST', '/api/recap/me/slaps', { count: SLAP_HAPPY_AT - 1 })).json() as { total: number }).total).toBe(SLAP_HAPPY_AT - 1);
      expect(t.ctx.stickers.unlockedBy(a!.id)[RECAP_STICKERS.slaps]).toBeUndefined();
      await req(t.app, a!.jar, 'POST', '/api/recap/me/slaps', { count: 1 });
      const got = t.ctx.stickers.unlockedBy(a!.id);
      expect(got[RECAP_STICKERS.rewind]).toBeDefined();
      expect(got[RECAP_STICKERS.shared]).toBeDefined();
      expect(got[RECAP_STICKERS.slaps]).toBeDefined();
    });
  });

  describe('load', () => {
    it('300 phones open their recap at the same moment, within budget', async () => {
      const ppl = people(t, 300);
      const db = t.ctx.db;
      db.exec('BEGIN');
      ppl.forEach((p, i) => {
        t.ctx.points.award({ attendeeId: p.id, source: 'attendance', ref: 'checkin:1', points: 10, label: 'checked in: opening jam' });
        t.ctx.points.award({ attendeeId: p.id, source: 'polls', ref: `vote:${i % 7}`, points: 2, label: 'weighed in' });
        if (i % 3 === 0) t.ctx.points.award({ attendeeId: p.id, source: 'arcade.reaction', ref: `run${i}`, points: 5 + (i % 11), label: 'lag spike' });
        t.ctx.stickers.unlock(p.id, 'showed-up');
        if (i % 10 === 0) t.ctx.stickers.unlock(p.id, 'reactions-hype');
        db.prepare('INSERT INTO morse_best (attendee_id, mode, level, best_score, best_wpm, attempts, first_clear_at) VALUES (?, ?, 1, 50, ?, 1, ?)').run(p.id, 'decode', 8 + (i % 9), t.clock.now());
      });
      db.exec('COMMIT');
      await open(true);
      const t0 = performance.now();
      const res = await Promise.all(ppl.map((p) => req(t.app, p.jar, 'GET', '/api/recap/me')));
      const ms = performance.now() - t0;
      expect(res.every((r) => r.statusCode === 200)).toBe(true);
      const recaps = res.map((r) => r.json() as Recap);
      expect(new Set(recaps.map((r) => r.attendee.id)).size).toBe(300);
      expect(recaps[0]!.sessions.count).toBe(1);
      expect(ms).toBeLessThan(6000);

      // second wave inside the cache window is cheaper still
      const t1 = performance.now();
      const again = await Promise.all(ppl.map((p) => req(t.app, p.jar, 'GET', '/api/recap/me')));
      expect(again.every((r) => r.statusCode === 200)).toBe(true);
      expect(performance.now() - t1).toBeLessThan(4000);

      // the projector's room totals stay quick with 300 people in them
      const t2 = performance.now();
      const room = await req(t.app, admin, 'GET', '/api/recap/room');
      expect(room.statusCode).toBe(200);
      expect(performance.now() - t2).toBeLessThan(300);
    }, 90_000);
  });
});
