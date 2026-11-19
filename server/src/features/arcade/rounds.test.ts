import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allPatches, applyPatch, runBot } from '@afterhours/shared/features/arcade-bot';
import { allPlans, greedyPlan, simulate } from '@afterhours/shared/features/arcade-net';
import { applyFlips, checkClues, countRepairs } from '@afterhours/shared/features/arcade-pixels';
import { LEVEL_POINTS, ROUND_COUNT, type RoundsHub, type StartAttemptResponse, type TryResponse, worthAfter } from '@afterhours/shared/features/arcade-rounds';
import { type Jar, type TestApp, adminJar, capture, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { type Level, LEVELS, levelById } from './levels';
import { tick } from './index';

const P = (game: Level['game']) => LEVELS.filter((l) => l.game === game) as Extract<Level, { game: typeof game }>[];

describe('arcade rounds: level design', () => {
  it('has one level per game per round, with rising points', () => {
    for (const game of ['packet', 'patch', 'pixels'] as const) {
      expect(P(game).map((l) => l.round)).toEqual([1, 2, 3, 4]);
    }
    expect(LEVELS).toHaveLength(3 * ROUND_COUNT);
    expect([...LEVEL_POINTS]).toEqual([...LEVEL_POINTS].sort((a, b) => a - b));
  });

  describe('packet panic', () => {
    const levels = LEVELS.filter((l): l is Extract<Level, { game: 'packet' }> => l.game === 'packet');
    it('every solution delivers every packet', () => {
      for (const l of levels) expect(simulate(l.network, l.solution).ok, l.id).toBe(true);
    });
    it('round 1 is one packet and two routes; blind send gets stuck with a reason', () => {
      const l = levels[0]!;
      expect(l.network.packets).toHaveLength(1);
      const r = simulate(l.network, {});
      expect(r.ok).toBe(false);
      expect(r.outcomes[0]!.reason).toMatch(/no arrow set for A at J1/);
      const wrong = simulate(l.network, { A: { j1: 'd' } });
      expect(wrong.outcomes[0]).toMatchObject({ status: 'lost', node: 'db' });
    });
    it('later rounds add competing packets, capacity and a failure, and the shortest-path plan fails them', () => {
      for (const l of levels.slice(1)) {
        expect(l.network.packets.length, l.id).toBeGreaterThan(1);
        expect(simulate(l.network, greedyPlan(l.network)).ok, l.id).toBe(false);
      }
      expect(levels[3]!.network.links.some((x) => x.downAt !== undefined)).toBe(true);
    });
    it('says exactly where and why a packet got stuck', () => {
      const l = levels[1]!;
      const r = simulate(l.network, greedyPlan(l.network));
      const b = r.outcomes.find((o) => o.id === 'B')!;
      expect(b.status).toBe('stuck');
      expect(b.reason).toMatch(/J2 to DB|time ran out/);
      const cut = levels[3]!;
      const late = simulate(cut.network, { ...cut.solution, B: { home: 'u', j1: 'q' } });
      expect(late.outcomes.find((o) => o.id === 'B')).toMatchObject({ status: 'stuck', node: 'j1', link: 'q', reason: expect.stringMatching(/went down at tick 2/) });
    });
    it('is deterministic: same plan, same frames, every time', () => {
      for (const l of levels) {
        for (const plan of [...allPlans(l.network)].slice(0, 50)) expect(JSON.stringify(simulate(l.network, plan))).toBe(JSON.stringify(simulate(l.network, plan)));
      }
    });
    it('hard levels have few winning plans', () => {
      for (const l of levels.slice(2)) {
        let total = 0;
        let wins = 0;
        for (const plan of allPlans(l.network)) {
          total++;
          if (simulate(l.network, plan).ok) wins++;
        }
        expect(wins / total, l.id).toBeLessThan(0.05);
      }
    });
  });

  describe('patch the bot', () => {
    const levels = LEVELS.filter((l): l is Extract<Level, { game: 'patch' }> => l.game === 'patch');
    it('the shipped program fails, the solution passes every map', () => {
      for (const l of levels) {
        expect(l.maps.some((m) => runBot(l.program, m, l.battery).ok), l.id).toBe(false);
        for (const m of l.maps) expect(runBot(applyPatch(l.program, l.solution), m, l.battery).ok, `${l.id} ${m.name}`).toBe(true);
      }
    });
    it('starts with one map and ends with the same patch passing three', () => {
      expect(levels[0]!.maps).toHaveLength(1);
      expect(levels[2]!.maps).toHaveLength(3);
      expect(levels[3]!.maps).toHaveLength(3);
    });
    it('from round 2 on exactly one patch passes every map', () => {
      for (const l of levels.slice(1)) {
        const winners = allPatches(l.program).filter((p) => l.maps.every((m) => runBot(applyPatch(l.program, p), m, l.battery).ok));
        expect(winners, l.id).toEqual([l.solution]);
      }
    });
    it('the obvious fix passes map 1 and fails a later map', () => {
      for (const l of levels.filter((x) => x.trap)) {
        const res = l.maps.map((m) => runBot(applyPatch(l.program, l.trap!), m, l.battery).ok);
        expect(res[0], l.id).toBe(true);
        expect(res.every(Boolean), l.id).toBe(false);
      }
    });
  });

  describe('rebuild the image', () => {
    const levels = LEVELS.filter((l): l is Extract<Level, { game: 'pixels' }> => l.game === 'pixels');
    it('round 1 is a 4x4 with one wrong pixel; later rounds add pixels, a tap budget and group clues', () => {
      expect(levels[0]!.puzzle).toMatchObject({ size: 4, maxFlips: 1, tapBudget: null, groups: [] });
      expect(levels[1]!.puzzle.maxFlips).toBeGreaterThan(1);
      expect(levels[2]!.puzzle.tapBudget).not.toBeNull();
      expect(levels[3]!.puzzle.groups.length).toBeGreaterThan(0);
    });
    it('clues and the flip limit leave exactly one repair, and it is the picture', () => {
      for (const l of levels) {
        expect(checkClues(l.puzzle, applyFlips(l.puzzle.start, [])).all, `${l.id} starts solved`).toBe(false);
        const r = countRepairs(l.puzzle, 2);
        expect(r.count, l.id).toBe(1);
        const fixed = applyFlips(l.puzzle.start, r.first!);
        expect(fixed.map((row) => row.map((b) => (b ? '1' : '0')).join(''))).toEqual(l.art);
        if (l.puzzle.tapBudget !== null) expect(l.puzzle.tapBudget).toBeGreaterThanOrEqual(l.wrong.length);
      }
    });
  });
});

describe('arcade rounds: api', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp({ env: { LOGIN_IP_PER_MIN: '100000' } });
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  type Person = { jar: Jar; id: number; kitId: string };
  async function people(n: number): Promise<Person[]> {
    const kits = await makeKits(t.app, n);
    const ppl = await Promise.all(kits.map(async (k, i) => ({ ...(await signedInAttendee(t.app, k, `p${i}`)), kitId: k.kitId })));
    t.ctx.db.exec('DELETE FROM points_ledger'); // exact totals below, without core's sign-in awards
    t.ctx.points.invalidate();
    return ppl;
  }
  let keyN = 0;
  const key = () => `k${(++keyN).toString().padStart(10, '0')}`;
  const release = (round: number) => req(t.app, admin, 'POST', '/api/arcade/rounds/admin/release', { round });
  const start = async (p: Person, levelId: string) => {
    const r = await req(t.app, p.jar, 'POST', '/api/arcade/rounds/attempts', { levelId });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as StartAttemptResponse;
  };
  const tryIt = async (p: Person, attemptId: string, plan: object, k = key()) => {
    t.clock.advance(1000); // past the try gap
    return req(t.app, p.jar, 'POST', `/api/arcade/rounds/attempts/${attemptId}/try`, { key: k, plan });
  };
  const hub = async (p: Person) => (await req(t.app, p.jar, 'GET', '/api/arcade/rounds')).json() as RoundsHub;
  const houses = async () => (await req(t.app, admin, 'GET', '/api/arcade/rounds/houses')).json() as { houses: { id: number; points: number; byRound: number[] }[] };
  const assign = (houseId: number, kitIds: string[]) => req(t.app, admin, 'POST', '/api/arcade/rounds/admin/houses/assign', { houseId, kitIds });
  const win = (l: Level) =>
    l.game === 'packet' ? { game: 'packet', routes: l.solution } : l.game === 'patch' ? { game: 'patch', patch: l.solution } : { game: 'pixels', taps: l.wrong };
  const lose = (l: Level) =>
    l.game === 'packet' ? { game: 'packet', routes: {} } : l.game === 'patch' ? { game: 'patch', patch: { line: 0, cmd: l.program[0] } } : { game: 'pixels', taps: [] };

  it('nothing is playable until the console releases round 1; unreleased levels look missing', async () => {
    const [a] = await people(1);
    expect((await hub(a!)).levels).toEqual([]);
    expect((await req(t.app, a!.jar, 'POST', '/api/arcade/rounds/attempts', { levelId: 'packet-1' })).statusCode).toBe(404);
    expect((await req(t.app, a!.jar, 'POST', '/api/arcade/rounds/attempts', { levelId: 'nope' })).statusCode).toBe(404);
  });

  it('organiser releases rounds in order, announces them live, and a double click cannot skip one', async () => {
    const [a] = await people(1);
    const cap = capture(t.ctx, { attendeeId: a!.id, admin: false, screen: false });
    expect((await release(2)).statusCode).toBe(409);
    expect((await release(1)).statusCode).toBe(200);
    expect((await release(1)).statusCode).toBe(409); // the double click
    expect(cap.events.filter((e) => e.type === 'arcade.round')).toHaveLength(1);
    expect(cap.events.find((e) => e.type === 'arcade.round')!.data).toMatchObject({ round: 1, titles: ['first hop', 'wrong turn', 'one bad pixel'] });
    const h = await hub(a!);
    expect(h.round).toBe(1);
    expect(h.levels.map((l) => l.id)).toEqual(['packet-1', 'patch-1', 'pixels-1']);
    // attendees cannot release
    expect((await req(t.app, a!.jar, 'POST', '/api/arcade/rounds/admin/release', { round: 2 })).statusCode).toBe(401);
    cap.unsub();
  });

  it('a losing run pays nothing and costs a point; the win pays once; a retried request never pays twice', async () => {
    const [a] = await people(1);
    await release(1);
    const s = await start(a!, 'patch-1');
    expect(s.attempt).toMatchObject({ mode: 'scored', worth: 4, round: 1 });
    expect(JSON.stringify(s)).not.toContain('solution');

    const l1 = await tryIt(a!, s.attempt.id, { game: 'patch', patch: { line: 0, cmd: 'left' } });
    const lost = l1.json() as TryResponse;
    expect(lost.ok).toBe(false);
    expect(lost.points).toBe(0);
    expect(lost.attempt).toMatchObject({ fails: 1, worth: worthAfter(4, 1) });
    expect(t.ctx.points.total(a!.id)).toBe(0);

    const k = key();
    const w = (await tryIt(a!, s.attempt.id, { game: 'patch', patch: { line: 2, cmd: 'right' } }, k)).json() as TryResponse;
    expect(w.ok).toBe(true);
    expect(w.points).toBe(3);
    expect(w.tokens).toBe(1);
    expect(t.ctx.points.total(a!.id)).toBe(3);
    // same key again: the stored answer, nothing new paid
    const again = await tryIt(a!, s.attempt.id, { game: 'patch', patch: { line: 2, cmd: 'right' } }, k);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(w);
    // new key on a won attempt: refused
    expect((await tryIt(a!, s.attempt.id, { game: 'patch', patch: { line: 2, cmd: 'right' } })).statusCode).toBe(409);
    expect(t.ctx.points.total(a!.id)).toBe(3);

    // replay: practice only
    const replay = await start(a!, 'patch-1');
    expect(replay.attempt).toMatchObject({ mode: 'replay', worth: 0 });
    const rw = (await tryIt(a!, replay.attempt.id, { game: 'patch', patch: { line: 2, cmd: 'right' } })).json() as TryResponse;
    expect(rw).toMatchObject({ ok: true, points: 0, tokens: 0 });
    expect(t.ctx.points.total(a!.id)).toBe(3);
    expect((await hub(a!)).levels.find((l) => l.id === 'patch-1')!.status).toBe('cleared');
  });

  it('wins and losses for every game, easy and hard, are judged on the server', async () => {
    const [a] = await people(1);
    for (let r = 1; r <= ROUND_COUNT; r++) await release(r);
    for (const l of LEVELS) {
      const s = await start(a!, l.id);
      expect(s.body.game).toBe(l.game);
      const bad = (await tryIt(a!, s.attempt.id, lose(l))).json() as TryResponse;
      expect(bad.ok, `${l.id} lose`).toBe(false);
      expect(bad.reveal).toBeNull();
      const good = (await tryIt(a!, s.attempt.id, win(l))).json() as TryResponse;
      expect(good.ok, `${l.id} win`).toBe(true);
      expect(good.points).toBe(worthAfter(LEVEL_POINTS[l.round - 1]!, 1));
      if (l.game === 'pixels') expect(good.reveal?.art).toEqual(l.art);
    }
  });

  it('pixels: going over the tap budget or changing too many pixels loses', async () => {
    const [a] = await people(1);
    for (let r = 1; r <= 3; r++) await release(r);
    const l = levelById('pixels-3') as Extract<Level, { game: 'pixels' }>;
    const s = await start(a!, l.id);
    const spam = [...l.wrong, [0, 0], [0, 0]] as [number, number][]; // right answer, but 5 taps > budget 4
    const over = (await tryIt(a!, s.attempt.id, { game: 'pixels', taps: spam })).json() as TryResponse;
    expect(over.ok).toBe(false);
    expect(over.outcome.game === 'pixels' && over.outcome.result.reason).toMatch(/out of taps/);
    expect((await tryIt(a!, s.attempt.id, { game: 'pixels', taps: [[9, 9]] })).statusCode).toBe(400);
  });

  it('an attempt keeps the round it started in when the next round drops mid-run, and resumes instead of switching', async () => {
    const [a] = await people(1);
    await release(1);
    const s = await start(a!, 'pixels-1');
    await release(2);
    const resumed = await start(a!, 'pixels-1');
    expect(resumed.attempt.id).toBe(s.attempt.id);
    expect(resumed.attempt.round).toBe(1);
    await assign(1, [a!.kitId]);
    const l = levelById('pixels-1')!;
    expect(((await tryIt(a!, s.attempt.id, win(l))).json() as TryResponse).ok).toBe(true);
    tick(t.ctx);
    const h = (await houses()).houses.find((x) => x.id === 1)!;
    expect(h.byRound).toEqual([4, 0, 0, 0]); // credited to round 1, where it started
    // a new attempt on a round-1 level now binds to round 2
    const late = await start(a!, 'packet-1');
    expect(late.attempt.round).toBe(2);
  });

  it('tries are rate limited per attempt', async () => {
    const [a] = await people(1);
    await release(1);
    const s = await start(a!, 'packet-1');
    expect((await tryIt(a!, s.attempt.id, { game: 'packet', routes: {} })).statusCode).toBe(200);
    expect((await req(t.app, a!.jar, 'POST', `/api/arcade/rounds/attempts/${s.attempt.id}/try`, { key: key(), plan: { game: 'packet', routes: {} } })).statusCode).toBe(429);
    // someone else's attempt is invisible
    const [b] = await people(1);
    expect((await tryIt(b!, s.attempt.id, { game: 'packet', routes: {} })).statusCode).toBe(404);
  });

  it('house totals come from eligible arcade awards, update live, and stay put when someone is moved', async () => {
    const [a, b] = await people(2);
    expect((await assign(1, [a!.kitId, 'AH-NOPE'])).json()).toEqual({ assigned: 1, unknown: ['AH-NOPE'] });
    await assign(2, [b!.kitId]);
    await release(1);
    const cap = capture(t.ctx, { attendeeId: b!.id, admin: false, screen: false });
    for (const p of [a!, b!]) {
      const s = await start(p, 'packet-1');
      await tryIt(p, s.attempt.id, win(levelById('packet-1')!));
    }
    t.clock.advance(3000);
    tick(t.ctx);
    expect(cap.types()).toContain('arcade.houses');
    let hs = (await houses()).houses;
    expect(hs.find((h) => h.id === 1)!.points).toBe(4);
    expect(hs.find((h) => h.id === 2)!.points).toBe(4);
    // the old mini-games don't count for houses
    t.ctx.points.award({ attendeeId: a!.id, source: 'arcade.reaction', ref: 'x', points: 10 });
    // organiser moves a to house 3: what a earned stays with house 1, the next win goes to house 3
    await assign(3, [a!.kitId]);
    const s2 = await start(a!, 'pixels-1');
    await tryIt(a!, s2.attempt.id, win(levelById('pixels-1')!));
    hs = (await houses()).houses;
    expect(hs.map((h) => h.points)).toEqual([4, 4, 4, 0]);
    // there is no attendee route to change house
    expect((await req(t.app, a!.jar, 'POST', '/api/arcade/rounds/admin/houses/assign', { houseId: 2, kitIds: [a!.kitId] })).statusCode).toBe(401);
    cap.unsub();
  });

  it('fill puts everyone without a house into the smallest one', async () => {
    const ppl = await people(6);
    await assign(1, [ppl[0]!.kitId, ppl[1]!.kitId]);
    expect((await req(t.app, admin, 'POST', '/api/arcade/rounds/admin/houses/fill', {})).json()).toEqual({ assigned: 4 });
    const hs = (await houses()).houses as unknown as { members: number }[];
    expect(hs.map((h) => h.members).sort()).toEqual([1, 1, 2, 2]);
  });

  it('a mocktail claim spends tokens, guards against double claims, and leaves points and houses alone', async () => {
    const [a] = await people(1);
    await assign(4, [a!.kitId]);
    await req(t.app, admin, 'POST', '/api/arcade/rounds/admin/rewards', { tokensPerClear: 1, mocktailCost: 2 });
    await release(1);
    const claim = (k: string) => req(t.app, admin, 'POST', '/api/arcade/rounds/admin/claim', { kitId: a!.kitId.toLowerCase(), key: k });
    expect((await claim('claimkey-0')).statusCode).toBe(409); // no tokens yet
    for (const id of ['packet-1', 'patch-1']) {
      const s = await start(a!, id);
      await tryIt(a!, s.attempt.id, win(levelById(id)!));
    }
    const before = { points: t.ctx.points.total(a!.id), house: (await houses()).houses.find((h) => h.id === 4)!.points, rank: t.ctx.points.rankOf(a!.id) };
    expect((await hub(a!)).rewards).toMatchObject({ earned: 2, spent: 0, balance: 2, mocktailCost: 2 });
    const c1 = await claim('claimkey-1');
    expect(c1.json()).toMatchObject({ duplicate: false, person: { rewards: { balance: 0, spent: 2 } } });
    const c2 = await claim('claimkey-1'); // double press / retry
    expect(c2.json()).toMatchObject({ duplicate: true, person: { rewards: { balance: 0, spent: 2 }, claims: [{ tokens: 2 }] } });
    expect((await claim('claimkey-2')).statusCode).toBe(409); // a second mocktail needs more tokens
    expect({ points: t.ctx.points.total(a!.id), house: (await houses()).houses.find((h) => h.id === 4)!.points, rank: t.ctx.points.rankOf(a!.id) }).toEqual(before);
    // the exchange rate can change on the day
    await req(t.app, admin, 'POST', '/api/arcade/rounds/admin/rewards', { tokensPerClear: 3 });
    expect((await hub(a!)).rewards).toMatchObject({ earned: 6, spent: 2, balance: 4 });
    // attendees cannot claim for themselves
    expect((await req(t.app, a!.jar, 'POST', '/api/arcade/rounds/admin/claim', { kitId: a!.kitId, key: 'claimkey-3' })).statusCode).toBe(401);
  });

  it('house perk: one extra hint per member for one round, one perk per house per round', async () => {
    const [a, b] = await people(2);
    await assign(1, [a!.kitId]);
    await assign(2, [b!.kitId]);
    await release(1);
    const perk = (houseId: number, round: number) => req(t.app, admin, 'POST', '/api/arcade/rounds/admin/perk', { houseId, round });
    expect((await perk(1, 2)).statusCode).toBe(200);
    expect((await perk(1, 2)).statusCode).toBe(409);
    await release(2);
    const sa = await start(a!, 'patch-2');
    const sb = await start(b!, 'patch-2');
    expect(sa.attempt.hintAvailable).toBe(true);
    expect(sb.attempt.hintAvailable).toBe(false);
    expect((await req(t.app, b!.jar, 'POST', `/api/arcade/rounds/attempts/${sb.attempt.id}/hint`)).statusCode).toBe(403);
    const h = await req(t.app, a!.jar, 'POST', `/api/arcade/rounds/attempts/${sa.attempt.id}/hint`);
    expect(h.json()).toMatchObject({ attempt: { hint: { game: 'patch', line: 1 }, hintAvailable: false } });
    // used up for this round, even on another level
    const other = await start(a!, 'packet-2');
    expect(other.attempt.hintAvailable).toBe(false);
    // an attempt from round 1 doesn't get round 2's perk
    expect((await perk(1, 1)).statusCode).toBe(409); // round 1 is over
  });

  it('reset wipes rounds, attempts, claims and round points but keeps houses', async () => {
    const [a] = await people(1);
    await assign(1, [a!.kitId]);
    await release(1);
    const s = await start(a!, 'packet-1');
    await tryIt(a!, s.attempt.id, win(levelById('packet-1')!));
    t.ctx.points.award({ attendeeId: a!.id, source: 'polls', ref: '1', points: 5 });
    expect((await req(t.app, admin, 'POST', '/api/arcade/rounds/admin/reset', { confirm: 'nope' })).statusCode).toBe(400);
    expect((await req(t.app, admin, 'POST', '/api/arcade/rounds/admin/reset', { confirm: 'RESET ROUNDS' })).statusCode).toBe(200);
    expect(t.ctx.points.total(a!.id)).toBe(5);
    const h = await hub(a!);
    expect(h).toMatchObject({ round: 0, levels: [], pointsEarned: 0, house: { id: 1, points: 0 } });
  });
});
