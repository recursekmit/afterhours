// Trails: isolation, challenge types, require-scan, online fallback, Morse cards, graph trails,
// Morse slips (every outcome, per-kit isolation, typed vs Morse), and the migration of old hunt data.
import { mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarFromSeed } from '@afterhours/shared';
import {
  type HuntAdmin,
  type HuntAttemptResult,
  type HuntMe,
  type HuntSlipResult,
  type MorseCardSheet,
  type SlipPrintSheet,
  type SlipSetList,
  type TrailGraph,
  type TrailList,
  slipWordKey,
} from '@afterhours/shared/features/hunt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newToken, sha256 } from '../../core/auth/crypto';
import { all, one, openDb, run } from '../../core/db';
import { runMigrations } from '../../core/migrate';
import { type TestApp, Jar, SRC_ROOT, adminJar, makeApp, req } from '../../../test/helpers';
import { SLIP_UNKNOWN } from './engine';
import { setVisibility } from './visibility';

let kitSeq = 0;
function fastAttendee(t: TestApp, nickname: string) {
  const n = ++kitSeq;
  const kitId = `TR-${String(n).padStart(4, '0')}`;
  const now = t.ctx.now();
  run(t.ctx.db, 'INSERT INTO kits (id, password_hash, created_at) VALUES (?, ?, ?)', kitId, 'x', now);
  const id = run(
    t.ctx.db,
    `INSERT INTO attendees (kit_id, name, roll, nickname, avatar, profile_complete, first_signin_at, profile_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    kitId,
    `Person ${n}`,
    `R${n}`,
    nickname,
    JSON.stringify(avatarFromSeed(n)),
    now,
    now,
  ).lastId;
  const token = newToken();
  run(t.ctx.db, "INSERT INTO sessions (token_hash, kind, attendee_id, created_at, expires_at) VALUES (?, 'attendee', ?, ?, ?)", sha256(token), id, now, now + 86_400_000);
  const jar = new Jar();
  jar.cookies.ah_sid = token;
  return { id, jar, kitId };
}
type Who = ReturnType<typeof fastAttendee>;

describe('trails', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    setVisibility(t.ctx, { hunt: true, morse: true }); // both events are hidden from players by default
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  const api = async <T>(who: Jar | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
    const r = await req(t.app, who, method, `/api/hunt${url}`, body);
    return { status: r.statusCode, body: r.json() as T, raw: r.body };
  };
  const newTrail = async (title: string, extra: object = {}) => (await api<HuntAdmin>(admin, 'POST', '/admin/trails', { title, ...extra })).body.trail.id;
  const addStop = async (trail: number, stop: object) => {
    const r = await api<HuntAdmin>(admin, 'POST', `/admin/stops?trail=${trail}`, stop);
    expect(r.status, r.raw).toBe(200);
    return r.body.stops.at(-1)!;
  };
  const open = async (trail: number) => expect((await api(admin, 'PUT', `/admin/state?trail=${trail}`, { status: 'open' })).status).toBe(200);
  const me = async (w: Who, trail: number) => (await api<HuntMe>(w.jar, 'GET', `?trail=${trail}`)).body;
  const start = async (w: Who, trail: number) => (await api<HuntMe>(w.jar, 'POST', '/start', { trailId: trail })).body;
  const answer = async (w: Who, stopId: number, text: string) => api<HuntAttemptResult>(w.jar, 'POST', '/answer', { stopId, answer: text });
  const slip = async (w: Who, stopId: number, read: { text?: string; morse?: string }) => api<HuntSlipResult>(w.jar, 'POST', '/slip', { stopId, ...read });

  describe('isolation and settings', () => {
    it('two trails keep their own progress, points and finish ranks', async () => {
      const a = await newTrail('alpha', { orderMode: 'fixed' });
      const b = await newTrail('bravo', { orderMode: 'fixed' });
      const a1 = await addStop(a, { title: 'a1', clue: 'c', answers: ['one'] });
      const a2 = await addStop(a, { title: 'a2', clue: 'c', answers: ['two'] });
      const b1 = await addStop(b, { title: 'b1', clue: 'c', answers: ['uno'] });
      await addStop(b, { title: 'b2', clue: 'c', answers: ['dos'] });
      await open(a);
      await open(b);
      const p = fastAttendee(t, 'p');
      const q = fastAttendee(t, 'q');
      await start(p, a);
      await start(q, a);
      await start(p, b);
      // q finishes trail a first, then p
      for (const w of [q, p]) {
        expect((await answer(w, a1.id, 'one')).body.result).toBe('solved');
        expect((await answer(w, a2.id, 'two')).body.result).toBe('solved');
      }
      expect((await me(q, a)).finish!.rank).toBe(1);
      expect((await me(p, a)).finish!.rank).toBe(2);
      // trail b is untouched by trail a: p is on b1 with nothing stamped
      const pb = await me(p, b);
      expect(pb.solved).toHaveLength(0);
      expect(pb.current!.stopId).toBe(b1.id);
      expect(pb.finish).toBeNull();
      expect(pb.pointsEarned).toBe(0);
      // finish refs are per trail
      expect(t.ctx.points.has(q.id, 'hunt', `t${a}:finish-rank`)).toBe(true);
      // answering trail b's stop does not count on trail a
      expect((await answer(p, b1.id, 'uno')).body.result).toBe('solved');
      expect((await me(p, a)).solved).toHaveLength(2);
      const list = (await api<TrailList>(p.jar, 'GET', '/trails')).body.trails;
      expect(list.find((x) => x.id === a)).toMatchObject({ solved: 2, finishedRank: 2 });
      expect(list.find((x) => x.id === b)).toMatchObject({ solved: 1, finishedRank: null });
    });

    it('fixed order is the same for everyone; hints off and cooldown off are honoured; reset is per trail', async () => {
      const tr = await newTrail('loose', { orderMode: 'fixed', hintsOn: false, cooldownOn: false });
      const s1 = await addStop(tr, { title: 's1', clue: 'c', answers: ['x'], hints: ['h1'] });
      await addStop(tr, { title: 's2', clue: 'c', answers: ['y'] });
      await open(tr);
      const [p, q] = [fastAttendee(t, 'p'), fastAttendee(t, 'q')];
      expect((await start(p, tr)).current!.stopId).toBe(s1.id);
      expect((await start(q, tr)).current!.stopId).toBe(s1.id);
      expect((await me(p, tr)).current!.hintsLeft).toBe(0);
      expect((await api(p.jar, 'POST', '/hint', { stopId: s1.id, n: 1 })).status).toBe(400);
      const wrong = (await answer(p, s1.id, 'nope')).body;
      expect(wrong).toMatchObject({ result: 'wrong', lockedUntil: 0, cooldownMs: 0 });
      expect((await answer(p, s1.id, 'x')).body.result).toBe('solved');
      // reset this trail: p's stamp and points go, the treasure hunt is not touched
      expect((await api(admin, 'POST', `/admin/reset?trail=${tr}`, { confirm: 'RESET HUNT' })).status).toBe(200);
      expect(t.ctx.points.has(p.id, 'hunt', `stop:${s1.id}`)).toBe(false);
      expect((await api<HuntAdmin>(admin, 'GET', `/admin?trail=${tr}`)).body).toMatchObject({ status: 'draft', players: 0 });
    });
  });

  describe('challenge types', () => {
    it('scan, riddle and morse stops; require-scan opens the answer box only after the QR', async () => {
      const tr = await newTrail('mix', { orderMode: 'fixed', kind: 'morse' });
      const scanStop = await addStop(tr, { title: 'scan', clue: 'find the sticker' });
      const riddle = await addStop(tr, { title: 'riddle', clue: 'what has keys', answers: ['keyboard'], requireScan: true });
      const morse = await addStop(tr, { title: 'morse', clue: 'decode the card', challenge: 'morse', answers: ['CODE'] });
      expect(scanStop.challenge).toBe('scan');
      expect(riddle.challenge).toBe('riddle');
      await open(tr);
      const p = fastAttendee(t, 'p');
      expect((await start(p, tr)).current).toMatchObject({ challenge: 'scan', canType: false });
      expect((await api<HuntAttemptResult>(p.jar, 'POST', '/scan', { code: scanStop.token })).body.result).toBe('solved');
      // riddle with requireScan: answering first is refused, scanning unlocks, then the answer works
      expect((await me(p, tr)).current).toMatchObject({ challenge: 'riddle', needsScan: true, canType: false });
      expect((await answer(p, riddle.id, 'keyboard')).status).toBe(400);
      const un = (await api<HuntAttemptResult>(p.jar, 'POST', '/scan', { code: riddle.token })).body;
      expect(un.result).toBe('unlocked');
      expect((await me(p, tr)).current).toMatchObject({ needsScan: false, canType: true });
      expect((await answer(p, riddle.id, 'keyboard')).body.result).toBe('solved');
      // morse stop: typing the decoded word solves it; the card's QR never solves it on its own
      expect((await me(p, tr)).current).toMatchObject({ challenge: 'morse', letters: 4, signal: null });
      expect((await api<HuntAttemptResult>(p.jar, 'POST', '/scan', { code: morse.token })).body.result).toBe('unlocked');
      expect((await answer(p, morse.id, 'cod')).body.result).toBe('wrong');
      t.clock.advance(5000);
      const done = (await answer(p, morse.id, 'code')).body;
      expect(done.result).toBe('solved');
      expect(t.ctx.stickers.unlockedBy(p.id)['trail-morse-first']).toBeDefined();
      expect(t.ctx.stickers.unlockedBy(p.id)['trail-morse-done']).toBeDefined();
    });

    it('online fallback sends the signal but never the readable word', async () => {
      const tr = await newTrail('online', { orderMode: 'fixed' });
      const st = await addStop(tr, { title: 'remote', clue: 'listen', challenge: 'morse', answers: ['PIXEL'], onlineFallback: true });
      await addStop(tr, { title: 'end', clue: 'c', answers: ['end'] });
      await open(tr);
      const p = fastAttendee(t, 'p');
      await start(p, tr);
      const raw = (await api(p.jar, 'GET', `?trail=${tr}`)).raw;
      const cur = (JSON.parse(raw) as HuntMe).current!;
      expect(cur.stopId).toBe(st.id);
      expect(cur.signal).not.toBeNull();
      expect(cur.signal!.segments.length).toBeGreaterThan(0);
      expect(raw.toUpperCase()).not.toContain('PIXEL');
      // nor its Morse spelled out
      expect(raw).not.toContain(slipWordKey('PIXEL'));
    });

    it('rejects a morse stop whose word has no Morse', async () => {
      const tr = await newTrail('bad');
      expect((await api(admin, 'POST', `/admin/stops?trail=${tr}`, { title: 'x', clue: 'c', challenge: 'morse', answers: ['héllo!'] })).status).toBe(200);
      expect((await api(admin, 'POST', `/admin/stops?trail=${tr}`, { title: 'y', clue: 'c', challenge: 'morse', answers: ['a', 'b'] })).status).toBe(400);
    });

    it('printable Morse cards carry the word as patterns, console only', async () => {
      const tr = await newTrail('cards');
      await addStop(tr, { title: 'cod', clue: 'c', challenge: 'morse', answers: ['COD'], requireScan: true, location: 'door' });
      await addStop(tr, { title: 'plain', clue: 'c', answers: ['x'] });
      const cards = (await api<MorseCardSheet>(admin, 'GET', `/admin/cards?trail=${tr}`)).body;
      expect(cards.cards).toHaveLength(1);
      expect(cards.cards[0]).toMatchObject({ word: 'COD', patterns: ['-.-.', '---', '-..'], requireScan: true, location: 'door' });
      expect(cards.cards[0]!.url).toContain('/hunt/s/');
      const p = fastAttendee(t, 'p');
      expect((await api(p.jar, 'GET', `/admin/cards?trail=${tr}`)).status).toBe(401);
    });
  });

  describe('graph trails', () => {
    it('exits pick the path, progress is the path taken, finishing means stamping a finale', async () => {
      const tr = await newTrail('graph', { orderMode: 'graph' });
      const s = await addStop(tr, { title: 'start', clue: 'c', answers: ['go'] });
      const left = await addStop(tr, { title: 'left', clue: 'c', answers: ['l'] });
      const right = await addStop(tr, { title: 'right', clue: 'c', answers: ['r'] });
      const end = await addStop(tr, { title: 'end', clue: 'c', answers: ['e'], finale: true });
      await api(admin, 'PUT', `/admin/stops/${s.id}`, { title: 'start', clue: 'c', answers: ['go'], nextStopId: right.id });
      await api(admin, 'PUT', `/admin/stops/${right.id}`, { title: 'right', clue: 'c', answers: ['r'], nextStopId: end.id });
      await api(admin, 'PUT', `/admin/stops/${left.id}`, { title: 'left', clue: 'c', answers: ['l'], nextStopId: end.id });
      await open(tr);
      const p = fastAttendee(t, 'p');
      expect((await start(p, tr)).current!.stopId).toBe(s.id);
      await answer(p, s.id, 'go');
      expect((await me(p, tr)).current!.stopId).toBe(right.id);
      // left is not on p's path: answering it is "not yours"
      expect((await answer(p, left.id, 'l')).body.result).toBe('not_yours');
      await answer(p, right.id, 'r');
      const atEnd = await me(p, tr);
      expect(atEnd.current).toMatchObject({ stopId: end.id, isFinal: true });
      const fin = (await answer(p, end.id, 'e')).body;
      expect(fin.result).toBe('solved');
      const after = await me(p, tr);
      expect(after.finish!.rank).toBe(1);
      expect(after.solved.map((x) => x.title)).toEqual(['start', 'right', 'end']); // the path, in order
      const g = (await api<TrailGraph>(admin, 'GET', `/admin/graph?trail=${tr}`)).body;
      expect(g.nodes.find((n) => n.stopId === end.id)!.finale).toBe(true);
      expect(g.edges.filter((e) => e.kind === 'exit')).toHaveLength(3);
      expect(g.deadEnds).toEqual([]);
    });

    it('lists non-finale stops with no way out as dead ends', async () => {
      const tr = await newTrail('dead', { orderMode: 'graph' });
      const a = await addStop(tr, { title: 'a', clue: 'c', answers: ['a'] });
      await addStop(tr, { title: 'b', clue: 'c', answers: ['b'], finale: true });
      expect((await api<TrailGraph>(admin, 'GET', `/admin/graph?trail=${tr}`)).body.deadEnds).toEqual([a.id]);
    });
  });

  describe('morse slips', () => {
    async function slipTrail(mode: 'shared' | 'per_kit' = 'shared', pool: string[] = []) {
      const tr = await newTrail('slips', { orderMode: 'graph', kind: 'morse' });
      const other = await newTrail('side quest', { orderMode: 'fixed' });
      await addStop(other, { title: 'o1', clue: 'c', answers: ['o'] });
      await addStop(other, { title: 'o2', clue: 'c', answers: ['p'] });
      await open(other);
      const sets = (await api<SlipSetList>(admin, 'POST', `/admin/slip-sets?trail=${tr}`, { title: 'kit', mode, pool })).body;
      const setId = sets.sets[0]!.id;
      const next = await addStop(tr, { title: 'next', clue: 'c', answers: ['n'], finale: true });
      const side = await addStop(tr, { title: 'side', clue: 'c', answers: ['s'], finale: true });
      const word = (w: string) => (mode === 'shared' ? w : null);
      const r = await api<SlipSetList>(admin, 'POST', `/admin/slip-sets/${setId}/slips`, {
        slipNo: 1,
        label: 'one',
        readings: [
          { orientation: 'bottom', word: word('LAB'), outcome: 'next', targetStopId: next.id },
          { orientation: 'left', word: word('STAGE'), outcome: 'branch', targetStopId: side.id },
          { orientation: 'right', word: word('HINT'), outcome: 'clue', clue: 'look up' },
          { orientation: 'top', word: word('GIFT'), outcome: 'bonus', bonusPoints: 7 },
          { orientation: 'extra', morse: '..- .-.. .-.-', outcome: 'decoy' },
          { orientation: 'extra', word: 'SIDE', outcome: 'branch', targetTrailId: other },
        ],
      });
      expect(r.status, r.raw).toBe(200);
      const slipId = r.body.sets[0]!.slips[0]!.id;
      const start = (await api<HuntAdmin>(admin, 'POST', `/admin/stops?trail=${tr}`, { title: 'slip stop', clue: 'scan slip 1', slipId })).body.stops.at(-1)!;
      // the slip stop must be the start: move it first
      const ids = (await api<HuntAdmin>(admin, 'GET', `/admin?trail=${tr}`)).body.stops.map((x) => x.id);
      await api(admin, 'PUT', `/admin/order?trail=${tr}`, { ids: [start.id, ...ids.filter((x) => x !== start.id)] });
      await open(tr);
      return { tr, other, setId, slipId, start, next, side };
    }

    it('every outcome: clue, bonus (pays once), decoy (no penalty), branch to a trail, next', async () => {
      const g = await slipTrail();
      const p = fastAttendee(t, 'p');
      expect((await start(p, g.tr)).current).toMatchObject({ stopId: g.start.id, challenge: 'slip', slip: { slipNo: 1, label: 'one' }, canType: false });
      const clue = (await slip(p, g.start.id, { text: 'hint' })).body;
      expect(clue).toMatchObject({ outcome: 'clue', clue: 'look up' });
      const bonus = (await slip(p, g.start.id, { morse: '--. .. ..-. -' })).body; // GIFT, as the scanner reports it
      expect(bonus).toMatchObject({ outcome: 'bonus', points: 7 });
      expect((await slip(p, g.start.id, { text: 'GIFT' })).body).toMatchObject({ outcome: 'bonus', points: 0 }); // once
      const before = t.ctx.points.total(p.id);
      const decoy = (await slip(p, g.start.id, { morse: '..- .-.. .-.-' })).body;
      expect(decoy.outcome).toBe('decoy');
      expect(t.ctx.points.total(p.id)).toBe(before);
      expect(decoy.me.current!.lockedUntil).toBe(0);
      const br = (await slip(p, g.start.id, { text: 'side' })).body;
      expect(br).toMatchObject({ outcome: 'branch', unlockedTrailId: g.other });
      expect((await me(p, g.other)).started).toBe(true);
      expect((await me(p, g.tr)).current!.stopId).toBe(g.start.id); // a trail branch does not move you
      const nx = (await slip(p, g.start.id, { text: 'lab' })).body;
      expect(nx.outcome).toBe('next');
      expect(nx.stamped!.title).toBe('slip stop');
      expect(nx.me.current!.stopId).toBe(g.next.id);
      const counts = (await api<SlipSetList>(admin, 'GET', `/admin/slip-sets?trail=${g.tr}`)).body.sets[0]!.slips[0]!.readings;
      expect(counts.find((r) => r.orientation === 'bottom')!.finds).toBe(1);
      expect(counts.find((r) => r.orientation === 'top')!.finds).toBe(1);
    });

    it('a branch to a stop sends you down a different path than next', async () => {
      const g = await slipTrail();
      const [p, q] = [fastAttendee(t, 'p'), fastAttendee(t, 'q')];
      await start(p, g.tr);
      await start(q, g.tr);
      expect((await slip(p, g.start.id, { text: 'lab' })).body.me.current!.stopId).toBe(g.next.id);
      expect((await slip(q, g.start.id, { text: 'stage' })).body.me.current!.stopId).toBe(g.side.id);
      // both finish at a finale, each on their own path
      expect((await answer(p, g.next.id, 'n')).body.result).toBe('solved');
      expect((await answer(q, g.side.id, 's')).body.result).toBe('solved');
      expect((await me(p, g.tr)).finish!.rank).toBe(1);
      expect((await me(q, g.tr)).finish!.rank).toBe(2);
      const graph = (await api<TrailGraph>(admin, 'GET', `/admin/graph?trail=${g.tr}`)).body;
      const edge = graph.edges.find((e) => e.kind === 'reading' && e.outcome === 'branch' && e.to === g.side.id)!;
      expect(edge.count).toBe(1);
    });

    it('typed and Morse input match the same way; unknown readings get the same reply and leak nothing', async () => {
      const g = await slipTrail();
      const p = fastAttendee(t, 'p');
      await start(p, g.tr);
      const a = await slip(p, g.start.id, { text: 'blah' });
      const b = await slip(p, g.start.id, { morse: '.-.. .- .-. .-' });
      const c = await slip(p, g.start.id, { morse: '... - .- --. . .' }); // STAGE with a stray dot
      for (const r of [a, b, c]) {
        expect(r.body.outcome).toBe('unknown');
        expect(r.body.message).toBe(SLIP_UNKNOWN);
        for (const w of ['LAB', 'STAGE', 'HINT', 'GIFT', 'SIDE']) {
          expect(r.raw.toUpperCase()).not.toContain(`"${w}"`);
          expect(r.raw).not.toContain(slipWordKey(w));
        }
      }
      // Morse look-alikes from print or OCR still match
      expect((await slip(p, g.start.id, { morse: '•—•• •— —•••' })).body.outcome).toBe('next'); // LAB
    });

    it('per-kit slips: each kit carries its own words; a friend\'s reading counts as unknown', async () => {
      const pool = ['ALPHA', 'BRAVO', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE'];
      const g = await slipTrail('per_kit', pool);
      const [p, q] = [fastAttendee(t, 'p'), fastAttendee(t, 'q')];
      await start(p, g.tr);
      await start(q, g.tr);
      const print = (await api<SlipPrintSheet>(admin, 'GET', `/admin/slip-print?set=${g.setId}`)).body;
      expect(print.mode).toBe('per_kit');
      const pSlip = print.slips.find((s) => s.kitId === p.kitId)!;
      const qSlip = print.slips.find((s) => s.kitId === q.kitId)!;
      expect(pSlip.slipNo).toBe(1);
      const pWords = Object.values(pSlip.edges).map((e) => e?.word);
      expect(new Set(pWords).size).toBe(4); // four different edges
      for (const w of pWords) expect(pool).toContain(w);
      // the stored draw is stable
      const again = (await api<SlipPrintSheet>(admin, 'GET', `/admin/slip-print?set=${g.setId}`)).body.slips.find((s) => s.kitId === p.kitId)!;
      expect(again.edges).toEqual(pSlip.edges);
      // q's bottom word, if it is not also one of p's words, is unknown for p
      const qBottom = qSlip.edges.bottom!.word;
      if (!pWords.includes(qBottom)) expect((await slip(p, g.start.id, { text: qBottom })).body.outcome).toBe('unknown');
      // p's own bottom edge works for p
      expect((await slip(p, g.start.id, { text: pSlip.edges.bottom!.word })).body.outcome).toBe('next');
      // explicit-sequence decoys are shared by every kit
      expect((await slip(q, g.start.id, { morse: '..- .-.. .-.-' })).body.outcome).toBe('decoy');
    });

    it('slip editor validation: same-trail targets, distinct edges', async () => {
      const g = await slipTrail();
      const foreign = (await api<HuntAdmin>(admin, 'GET', `/admin?trail=${g.other}`)).body.stops[0]!.id;
      expect((await api(admin, 'PUT', `/admin/slips/${g.slipId}`, { slipNo: 1, readings: [{ orientation: 'bottom', word: 'X', outcome: 'next', targetStopId: foreign }] })).status).toBe(400);
      expect(
        (
          await api(admin, 'PUT', `/admin/slips/${g.slipId}`, {
            slipNo: 1,
            readings: [
              { orientation: 'bottom', word: 'X', outcome: 'decoy' },
              { orientation: 'top', word: 'x', outcome: 'decoy' },
            ],
          })
        ).status,
      ).toBe(400);
    });
  });
});

describe('trails migration', () => {
  it('moves existing hunt data onto the treasure trail (trail 1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-trails-'));
    try {
      const huntDir = join(root, 'hunt');
      mkdirSync(huntDir);
      copyFileSync(join(SRC_ROOT, 'features/hunt/migrations/001_hunt.sql'), join(huntDir, '001_hunt.sql'));
      const db = openDb(':memory:');
      const sources = [
        { scope: 'core', dir: join(SRC_ROOT, 'core/migrations') },
        { scope: 'hunt', dir: huntDir },
      ];
      runMigrations(db, sources);
      run(db, "UPDATE hunt_state SET status = 'open', title = 'old hunt' WHERE id = 1");
      run(db, "INSERT INTO kits (id, password_hash, created_at) VALUES ('K-1', 'x', 1)");
      const aid = run(db, "INSERT INTO attendees (kit_id, nickname, profile_complete, first_signin_at) VALUES ('K-1', 'old', 1, 1)").lastId;
      const riddle = run(db, "INSERT INTO hunt_stops (position, title, clue, answers, token, code) VALUES (1, 'r', 'c', '[\"a\"]', 't1', 'AAAAAAAA')").lastId;
      run(db, "INSERT INTO hunt_stops (position, title, clue, answers, token, code) VALUES (2, 's', 'c', '[]', 't2', 'BBBBBBBB')");
      run(db, 'INSERT INTO hunt_players (attendee_id, started_at, last_at, finished_at, finish_rank) VALUES (?, 5, 6, 7, 1)', aid);
      run(db, "INSERT INTO hunt_progress (attendee_id, stop_id, solved_at, via, points) VALUES (?, ?, 6, 'answer', 10)", aid, riddle);
      // now the trails migrations
      copyFileSync(join(SRC_ROOT, 'features/hunt/migrations/002_trails.sql'), join(huntDir, '002_trails.sql'));
      copyFileSync(join(SRC_ROOT, 'features/hunt/migrations/003_slips.sql'), join(huntDir, '003_slips.sql'));
      runMigrations(db, sources);
      expect(one(db, 'SELECT id, kind, title, status FROM hunt_trails')).toEqual({ id: 1, kind: 'hunt', title: 'old hunt', status: 'open' });
      expect(all(db, 'SELECT title, trail_id, challenge FROM hunt_stops ORDER BY position')).toEqual([
        { title: 'r', trail_id: 1, challenge: 'riddle' },
        { title: 's', trail_id: 1, challenge: 'scan' },
      ]);
      expect(one(db, 'SELECT trail_id, attendee_id, finish_rank FROM hunt_players')).toEqual({ trail_id: 1, attendee_id: aid, finish_rank: 1 });
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM hunt_progress')!.n).toBe(1);
      expect(one(db, "SELECT name FROM sqlite_master WHERE name = 'hunt_state'")).toBeUndefined();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
