// The Cipher Ticket: every trial's server rules, concurrency and the visibility gate.
import { type CipherAdmin, type CipherMe, type CipherScreen, type EchoResult, type GuessResult, type ScanResult, DEFAULT_CIPHER_SETTINGS, GUILDS } from '@afterhours/shared/features/cipher';
import { slipWordKey } from '@afterhours/shared/features/hunt';
import { reverseReading } from '@afterhours/shared/morse-slip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, type Jar, adminJar, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { all, one } from '../../core';
import { judgeEcho, riddleAnswer, standings } from './service';
import { type Words, copyWords, makeTicketSet, tapsFor } from './testkit';

let t: TestApp;
let slips: number[] = [];
let words: Map<number, Words[]>;
const responses: string[] = [];
const P = DEFAULT_CIPHER_SETTINGS.points;

async function call<T>(jar: Jar | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await req(t.app, jar, method, url, body);
  responses.push(r.body);
  return { status: r.statusCode, body: r.json() as T };
}

async function players(n: number) {
  const kits = await makeKits(t.app, n);
  const out: { jar: Jar; id: number }[] = [];
  for (let i = 0; i < n; i++) out.push(await signedInAttendee(t.app, kits[i]!, `player${i}`));
  return out;
}

const me = async (jar: Jar) => (await call<CipherMe>(jar, 'GET', '/api/cipher/me')).body;
const scanWord = async (jar: Jar, text: string) => call<ScanResult>(jar, 'POST', '/api/cipher/scan', { text });
const scanMorse = async (jar: Jar, morse: string) => call<ScanResult>(jar, 'POST', '/api/cipher/scan', { morse });
const slip = (serial: number, n: number) => words.get(serial)![n - 1]!;

/** Claim set `serial` with slip I's bottom edge, swear, and read slip I's other three edges. */
async function throughWinds(jar: Jar, serial: number) {
  const w = slip(serial, 1);
  await scanWord(jar, w.bottom);
  await call(jar, 'POST', '/api/cipher/oath');
  for (const e of ['right', 'top', 'left'] as const) await scanWord(jar, w[e]);
}

/** Decode the named edge of slip II (the test reads it off the printed copy) and tap it. */
async function throughEcho(jar: Jar, serial: number) {
  t.clock.advance(5000);
  const m = await me(jar);
  return call<EchoResult>(jar, 'POST', '/api/cipher/echo', { presses: tapsFor(slip(serial, 2)[m.echo.edge!], 120, 0.08) });
}

/** The printed design of slip n of a serial (hunt stores one per copy). */
function designOf(serial: number, n: number): string {
  return one<{ design: string }>(t.ctx.db, 'SELECT design FROM hunt_slip_copies WHERE slip_id = ? AND serial = ?', slips[n - 1]!, serial)!.design;
}

function whisperOf(attendeeId: number): string {
  return one<{ word: string }>(t.ctx.db, 'SELECT w.word FROM cipher_whispers w JOIN cipher_players p ON p.copy_id = w.copy_id WHERE p.attendee_id = ?', attendeeId)!.word;
}

async function throughWhisper(jar: Jar, id: number) {
  return call<GuessResult>(jar, 'POST', '/api/cipher/whisper', { guess: whisperOf(id) });
}

beforeEach(async () => {
  t = await makeApp();
  ({ slips } = makeTicketSet(t.ctx, 12));
  words = copyWords(t.ctx, slips);
  responses.length = 0;
});
afterEach(async () => {
  await t.close();
});

describe('the oath: claiming a set of four slips', () => {
  it('any edge of any slip reserves all four slips of that serial; slip I names the guild', async () => {
    const [a] = await players(1);
    // slip III's right edge, serial 2
    const r = await scanWord(a!.jar, slip(2, 3).right);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('claimed');
    expect(r.body.edge).toBeNull(); // not slip I: no rune yet
    expect(r.body.me.ticket).toMatchObject({ serial: 2, guild: designOf(2, 1) });
    // all four slips of serial 2 are now this attendee's (hunt's claim)
    const owners = all<{ claimed_by: number | null }>(t.ctx.db, `SELECT claimed_by FROM hunt_slip_copies WHERE serial = 2 AND slip_id IN (${slips.join(',')})`);
    expect(owners.map((o) => o.claimed_by)).toEqual([a!.id, a!.id, a!.id, a!.id]);
    // the oath seals trial 1
    const sworn = (await call<CipherMe>(a!.jar, 'POST', '/api/cipher/oath')).body;
    expect(sworn.trial).toBe(2);
    expect(sworn.stars).toHaveLength(7);
    expect(sworn.stars[0]).toMatchObject({ trial: 'oath', stars: 3, points: P.oath });
    // a slip I edge lights a rune
    const rune = await scanWord(a!.jar, slip(2, 1).right);
    expect(rune.body.outcome).toBe('rune');
    expect(rune.body.me.points).toBe(P.oath + P.rune);
  });

  it('guilds: the printed design of slip I; every serial holds all four designs, slip I balanced over the set', () => {
    for (const serial of [1, 2, 3, 7]) expect(new Set([1, 2, 3, 4].map((n) => designOf(serial, n))).size).toBe(4);
    const counts = new Map<string, number>();
    for (let serial = 1; serial <= 12; serial++) counts.set(designOf(serial, 1), (counts.get(designOf(serial, 1)) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3, 3]);
  });

  it("someone else's slips are refused; a second set is refused; unknown readings say nothing", async () => {
    const [a, b] = await players(2);
    await scanWord(a!.jar, slip(1, 1).bottom);
    // B tries slip IV of A's serial: the whole serial is A's
    const stolen = await scanWord(b!.jar, slip(1, 4).left);
    expect(stolen.body.outcome).toBe('taken');
    expect(stolen.body.me.ticket).toBeNull();
    expect((await scanWord(b!.jar, 'QQQQ')).body.outcome).toBe('unknown');
    await scanWord(b!.jar, slip(3, 2).bottom);
    expect((await me(b!.jar)).ticket!.serial).toBe(3);
    // A scanning serial 4 is "not yours", and claims nothing
    const other = await scanWord(a!.jar, slip(4, 1).bottom);
    expect(other.body.outcome).toBe('not_yours');
    expect(all(t.ctx.db, `SELECT 1 FROM hunt_slip_copies WHERE serial = 4 AND claimed_by IS NOT NULL`)).toHaveLength(0);
  });

  it('race: ten phones scan slips of the same serial at once, exactly one owns all four', async () => {
    const ps = await players(10);
    const rs = await Promise.all(ps.map((p, i) => scanWord(p.jar, slip(5, (i % 4) + 1).bottom)));
    expect(rs.filter((r) => r.body.outcome === 'claimed')).toHaveLength(1);
    expect(rs.filter((r) => r.body.outcome === 'taken')).toHaveLength(9);
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM cipher_players')!.n).toBe(1);
    const owners = new Set(all<{ claimed_by: number }>(t.ctx.db, `SELECT claimed_by FROM hunt_slip_copies WHERE serial = 5 AND slip_id IN (${slips.join(',')})`).map((r) => r.claimed_by));
    expect(owners.size).toBe(1);
  });

  it('a slip claimed through the morse trail brings the rest of its serial along', async () => {
    const [a] = await players(1);
    t.ctx.db.prepare('UPDATE hunt_slip_copies SET claimed_by = ?, claimed_at = 1 WHERE slip_id = ? AND serial = 7').run(a!.id, slips[2]!);
    const m = await me(a!.jar);
    expect(m.ticket).toMatchObject({ serial: 7, guild: designOf(7, 1) });
    expect(all(t.ctx.db, `SELECT 1 FROM hunt_slip_copies WHERE serial = 7 AND claimed_by = ${a!.id}`)).toHaveLength(4);
  });
});

describe('the four winds (slip I)', () => {
  it('every edge lights its rune once; the upside-down top is cursed and still counts; all four seal the trial', async () => {
    const [a] = await players(1);
    const w = slip(1, 1);
    await scanWord(a!.jar, w.bottom);
    await call(a!.jar, 'POST', '/api/cipher/oath');
    expect((await scanWord(a!.jar, w.bottom)).body.outcome).toBe('again');
    // another slip's edge does not count for the winds
    const s2 = await scanWord(a!.jar, slip(1, 2).right);
    expect(s2.body.outcome).toBe('again');
    expect(s2.body.message).toContain('slip II');
    expect((await scanWord(a!.jar, w.right)).body.outcome).toBe('rune');
    // slip I's top strip seen upside down: its symbol sequence reversed
    const cursed = await scanMorse(a!.jar, reverseReading(slipWordKey(w.top)));
    expect(cursed.body.outcome).toBe('cursed');
    expect(cursed.body.edge).toBe('top');
    expect(cursed.body.me.winds).toMatchObject({ cursed: true, found: { top: true } });
    const last = await scanWord(a!.jar, w.left);
    expect(last.body.outcome).toBe('rune');
    expect(last.body.me.trial).toBe(3);
    expect(last.body.me.stars[1]).toMatchObject({ trial: 'winds', stars: 3 });
    expect(last.body.me.points).toBe(P.oath + 4 * P.rune + P.speed);
  });

  it('hints: "turn it all the way round" after 2 minutes, the missing edges after 4', async () => {
    const [a] = await players(1);
    await scanWord(a!.jar, slip(1, 1).bottom);
    await call(a!.jar, 'POST', '/api/cipher/oath');
    expect((await me(a!.jar)).winds.hint).toBe(0);
    t.clock.advance(121_000);
    expect((await me(a!.jar)).winds.hint).toBe(1);
    t.clock.advance(120_000);
    const m = await me(a!.jar);
    expect(m.winds.hint).toBe(2);
    expect(m.winds.found).toEqual({ bottom: true, right: false, top: false, left: false });
  });

  it('a slow four winds still seals, without the speed bonus, and the streak breaks', async () => {
    const [a] = await players(1);
    const w = slip(1, 1);
    await scanWord(a!.jar, w.bottom);
    await call(a!.jar, 'POST', '/api/cipher/oath');
    t.clock.advance(10 * 60_000);
    for (const e of ['right', 'top', 'left'] as const) await scanWord(a!.jar, w[e]);
    const m = await me(a!.jar);
    expect(m.trial).toBe(3);
    expect(m.stars[1]!.stars).toBe(2);
    expect(m.streak).toBe(0);
  });
});

describe('the echo (slip II)', () => {
  it('names an edge of slip II; the word itself is not sent until the echo is sealed', async () => {
    const [a] = await players(1);
    await throughWinds(a!.jar, 1);
    const m = await me(a!.jar);
    expect(m.trial).toBe(3);
    expect(m.echo.edge).not.toBeNull();
    const word = slip(1, 2)[m.echo.edge!];
    expect(m.echo.letters).toBe(word.length);
    expect(m.echo.word).toBeNull();
    expect(JSON.stringify(m)).not.toContain(`"${word}"`);
    const ok = await throughEcho(a!.jar, 1);
    expect(ok.body.sealed).toBe(true);
    expect(ok.body.me.echo.word).toBe(word);
  });

  it('clean taps pass with stars; a wrong word costs a try', async () => {
    const [a] = await players(1);
    await throughWinds(a!.jar, 1);
    const edge = (await me(a!.jar)).echo.edge!;
    t.clock.advance(20_000);
    const wrong = await call<EchoResult>(a!.jar, 'POST', '/api/cipher/echo', { presses: tapsFor('EEE', 120, 0.05) });
    expect(wrong.body.passed).toBe(false);
    expect(wrong.body.triesLeft).toBe(2);
    const ok = await call<EchoResult>(a!.jar, 'POST', '/api/cipher/echo', { presses: tapsFor(slip(1, 2)[edge], 120, 0.1, 7) });
    expect(ok.body.passed).toBe(true);
    expect(ok.body.stars).toBeGreaterThanOrEqual(2);
    expect(ok.body.me.trial).toBe(4);
  });

  it('judging: about 1.5x tolerance passes jitter that strict judgeTaps would miss, never a different word', () => {
    const s = DEFAULT_CIPHER_SETTINGS;
    let strictMisses = 0;
    let passes = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = judgeEcho('GPU', tapsFor('GPU', 150, 0.42, seed), s);
      if (r.j.verdict !== 'ok' && r.j.verdict !== 'sloppy') strictMisses++;
      if (r.passed) passes++;
    }
    expect(passes).toBeGreaterThan(60 - strictMisses);
    expect(passes).toBeGreaterThanOrEqual(50);
    for (const other of ['GPS', 'BUG', 'API', 'GIT']) expect(judgeEcho('GPU', tapsFor(other, 150, 0.05), s).passed).toBe(false);
    const strict = { ...s, echoTolerance: 1 };
    let strictPasses = 0;
    for (let seed = 1; seed <= 60; seed++) if (judgeEcho('GPU', tapsFor('GPU', 150, 0.42, seed), strict).passed) strictPasses++;
    expect(strictPasses).toBeLessThan(passes);
    expect(judgeEcho('NODE', tapsFor('NODE', 100, 0), s).passed).toBe(false); // machine-perfect
    expect(judgeEcho('GPU', tapsFor('GPU', 150, 0.09, 3), s).stars).toBe(3);
  });

  it('three misses seal it without a star (never stuck); taps longer than the trial are refused', async () => {
    const [a] = await players(1);
    await throughWinds(a!.jar, 1);
    const tooLong = await call<EchoResult>(a!.jar, 'POST', '/api/cipher/echo', { presses: [[0, 100], [200, 300], [60_000, 60_100]] });
    expect(tooLong.status).toBe(400);
    t.clock.advance(30_000);
    let last: EchoResult | null = null;
    for (let i = 0; i < 3; i++) last = (await call<EchoResult>(a!.jar, 'POST', '/api/cipher/echo', { presses: tapsFor('EEEEE', 120, 0.05, i + 1) })).body;
    expect(last!.sealed).toBe(true);
    expect(last!.stars).toBe(0);
    expect(last!.me.trial).toBe(4);
  });
});

describe('the whisper', () => {
  it('a word only this set has, printed on none of its slips, never sent readable; hints cost a little', async () => {
    const ps = await players(3);
    for (const [i, p] of ps.entries()) {
      await throughWinds(p.jar, i + 1);
      await throughEcho(p.jar, i + 1);
    }
    const ws = ps.map((p) => whisperOf(p.id));
    expect(new Set(ws).size).toBe(3);
    for (const [i, w] of ws.entries()) {
      expect(w.length).toBeGreaterThanOrEqual(3);
      expect(w.length).toBeLessThanOrEqual(4);
      expect(words.get(i + 1)!.flatMap((x) => Object.values(x))).not.toContain(w);
    }
    const a = ps[0]!;
    const m = await me(a.jar);
    expect(m.trial).toBe(4);
    expect(m.whisper.signal!.segments.length).toBeGreaterThan(2);
    const h1 = (await call<CipherMe>(a.jar, 'POST', '/api/cipher/whisper/hint')).body;
    expect(h1.whisper.firstLetter).toBe(ws[0]![0]);
    expect(h1.whisper.letters).toBeNull();
    const h2 = (await call<CipherMe>(a.jar, 'POST', '/api/cipher/whisper/hint')).body;
    expect(h2.whisper.letters).toBe(ws[0]!.length);
    expect((await call<GuessResult>(a.jar, 'POST', '/api/cipher/whisper', { guess: 'ZZZZ' })).body.correct).toBe(false);
    const before = responses.join('\n');
    const right = await call<GuessResult>(a.jar, 'POST', '/api/cipher/whisper', { guess: ws[0]!.toLowerCase() });
    expect(right.body.correct).toBe(true);
    expect(right.body.points).toBe(P.whisper - 2 * DEFAULT_CIPHER_SETTINGS.whisperHintCost + P.speed);
    expect(right.body.me.trial).toBe(5);
    for (const w of ws) {
      expect(before).not.toContain(`"${w}"`);
      expect(before.toUpperCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
    const after = responses.join('\n').toUpperCase();
    for (const w of ws.slice(1)) expect(after).not.toMatch(new RegExp(`\\b${w}\\b`));
  });

  it('Farnsworth: letters at 8 wpm, gaps between letters stretched', async () => {
    const [a] = await players(1);
    await throughWinds(a!.jar, 1);
    await throughEcho(a!.jar, 1);
    const sig = (await me(a!.jar)).whisper.signal!;
    expect(sig.unitMs).toBe(150);
    expect(Math.max(...sig.segments)).toBeGreaterThan(3 * 150);
  });
});

describe('the riddle (slip III)', () => {
  it('the answer is the slip III word first (or last) alphabetically; other words of slip III are named as such; a hint names the edge', async () => {
    const ps = await players(2);
    for (const [i, p] of ps.entries()) {
      await throughWinds(p.jar, i + 1);
      await throughEcho(p.jar, i + 1);
      await throughWhisper(p.jar, p.id);
    }
    const rules = new Set<string>();
    for (const [i, p] of ps.entries()) {
      const m = await me(p.jar);
      expect(m.trial).toBe(5);
      expect(m.riddle.rule).not.toBeNull();
      rules.add(m.riddle.rule!);
      const three = slip(i + 1, 3);
      const ans = riddleAnswer(three, m.riddle.rule!)!;
      const sorted = Object.values(three).sort();
      expect(ans.word).toBe(m.riddle.rule === 'first' ? sorted[0] : sorted[3]);
      // nothing about slip III travels before it is solved
      for (const w of Object.values(three)) expect(JSON.stringify(m)).not.toContain(`"${w}"`);
      const wrongOne = sorted.find((w) => w !== ans.word)!;
      const wrong = await call<GuessResult>(p.jar, 'POST', '/api/cipher/riddle', { guess: wrongOne });
      expect(wrong.body.correct).toBe(false);
      expect(wrong.body.message).toContain('not the one the riddle asks for');
      const hinted = (await call<CipherMe>(p.jar, 'POST', '/api/cipher/riddle/hint')).body;
      expect(hinted.riddle.hintEdge).toBe(ans.edge);
      const right = await call<GuessResult>(p.jar, 'POST', '/api/cipher/riddle', { guess: ans.word });
      expect(right.body.correct).toBe(true);
      expect(right.body.points).toBe(P.riddle - DEFAULT_CIPHER_SETTINGS.riddleHintCost + P.speed);
      expect(right.body.me.trial).toBe(6);
    }
  });

  it('M1: after the riddle a player sees "next trials open soon" when the pact is closed', async () => {
    const [a] = await players(1);
    await throughWinds(a!.jar, 1);
    await throughEcho(a!.jar, 1);
    await throughWhisper(a!.jar, a!.id);
    const m = await me(a!.jar);
    const ans = riddleAnswer(slip(1, 3), m.riddle.rule!)!;
    await call(a!.jar, 'POST', '/api/cipher/riddle', { guess: ans.word });
    const admin = await adminJar(t.app);
    const adm = (await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin;
    await req(t.app, admin, 'PUT', '/api/cipher/admin/settings', { ...adm.settings, pactOpen: false });
    const after = await me(a!.jar);
    expect(after.trial).toBe(6);
    expect(after.nextSoon).toBe(true);
    expect(after.pact.status).toBe('locked');
  });
});

/** Through trials 1-5 by the API, to the pact. */
async function toPact(jar: Jar, id: number, serial: number) {
  await throughWinds(jar, serial);
  await throughEcho(jar, serial);
  await throughWhisper(jar, id);
  const m = await me(jar);
  const ans = riddleAnswer(slip(serial, 3), m.riddle.rule!)!;
  await call(jar, 'POST', '/api/cipher/riddle', { guess: ans.word });
}
/** Serials whose slip I is printed in `n` different designs, plus a same-design twin of the first. */
function serialsByGuild(): { distinct: number[]; twin: number } {
  const distinct: number[] = [];
  const seen = new Set<string>();
  for (let s = 1; s <= 12; s++) {
    if (seen.has(designOf(s, 1))) continue;
    seen.add(designOf(s, 1));
    distinct.push(s);
  }
  const twin = [...Array(12).keys()].map((i) => i + 1).find((s) => s !== distinct[0] && designOf(s, 1) === designOf(distinct[0]!, 1))!;
  return { distinct, twin };
}

describe('the pact (slip IV)', () => {
  it('pairs only across guilds; each scans the other’s slip IV at the named edge, without claiming; both seal it', async () => {
    const { distinct, twin } = serialsByGuild();
    const [a, b, c] = await players(3);
    await toPact(a!.jar, a!.id, distinct[0]!);
    expect((await me(a!.jar)).pact.status).toBe('waiting');
    // same guild: no pact
    await toPact(b!.jar, b!.id, twin);
    expect((await me(b!.jar)).pact.status).toBe('waiting');
    expect((await me(a!.jar)).pact.status).toBe('waiting');
    // another guild: paired with the one waiting longest (a)
    await toPact(c!.jar, c!.id, distinct[1]!);
    const ma = await me(a!.jar);
    const mc = await me(c!.jar);
    expect(ma.pact.status).toBe('paired');
    expect(ma.pact.partner).toMatchObject({ nickname: 'player2', guild: designOf(distinct[1]!, 1) });
    expect(mc.pact.partner).toMatchObject({ nickname: 'player0', guild: designOf(distinct[0]!, 1) });
    expect(ma.pact.scanEdge).toBe(mc.pact.showEdge);
    expect(mc.pact.scanEdge).toBe(ma.pact.showEdge);
    // the partner's words never travel
    for (const w of Object.values(slip(distinct[1]!, 4))) expect(JSON.stringify(ma)).not.toContain(`"${w}"`);
    // own slip IV, a wrong edge, another slip of theirs: no
    expect((await scanWord(a!.jar, slip(distinct[0]!, 4).bottom)).body.message).toContain('your own slip IV');
    const wrongEdge = (['bottom', 'right', 'top', 'left'] as const).find((e) => e !== ma.pact.scanEdge)!;
    expect((await scanWord(a!.jar, slip(distinct[1]!, 4)[wrongEdge])).body.message).toContain('wrong edge');
    expect((await scanWord(a!.jar, slip(distinct[1]!, 2).bottom)).body.message).toContain('their slip II');
    // the right one: half sealed
    const half = await scanWord(a!.jar, slip(distinct[1]!, 4)[ma.pact.scanEdge!]);
    expect(half.body.outcome).toBe('pact_half');
    expect((await me(c!.jar)).pact.theyScanned).toBe(true);
    // nothing claimed by a partner scan: every slip of c's serial is still c's
    expect(all<{ claimed_by: number }>(t.ctx.db, `SELECT claimed_by FROM hunt_slip_copies WHERE serial = ${distinct[1]} AND slip_id IN (${slips.join(',')})`).every((r) => r.claimed_by === c!.id)).toBe(true);
    const both = await scanWord(c!.jar, slip(distinct[0]!, 4)[mc.pact.scanEdge!]);
    expect(both.body.outcome).toBe('pact_sealed');
    expect(both.body.points).toBe(P.pact + P.speed);
    for (const p of [a!, c!]) {
      const m = await me(p.jar);
      expect(m.trial).toBe(7);
      expect(m.stars[5]!.sealedAt).not.toBeNull();
    }
    const admin = await adminJar(t.app);
    const screen = (await req(t.app, admin, 'GET', '/api/cipher/screen')).json() as { pactsSealed: number; recentPacts: { a: string; b: string }[] };
    expect(screen.pactsSealed).toBe(1);
    expect([screen.recentPacts[0]!.a, screen.recentPacts[0]!.b].sort()).toEqual(['player0', 'player2']);
  });

  it('after the wait with nobody: the Oracle completes it; re-pair before the wait is refused', async () => {
    const [a] = await players(1);
    await toPact(a!.jar, a!.id, 1);
    expect((await me(a!.jar)).pact).toMatchObject({ status: 'waiting', canRepair: false });
    expect((await call(a!.jar, 'POST', '/api/cipher/pact/oracle')).status).toBe(409);
    t.clock.advance(181_000);
    expect((await me(a!.jar)).pact.canRepair).toBe(true);
    const o = (await call<CipherMe>(a!.jar, 'POST', '/api/cipher/pact/oracle')).body;
    expect(o.pact.status).toBe('oracle');
    expect(o.pact.partner).toBeNull();
    const oracle = DEFAULT_CIPHER_SETTINGS.oracle;
    // the Oracle's words never travel to the phone
    expect(JSON.stringify(o)).not.toContain(oracle[o.pact.scanEdge!]);
    const r = await scanWord(a!.jar, oracle[o.pact.scanEdge!]);
    expect(r.body.outcome).toBe('pact_sealed');
    expect(r.body.me.trial).toBe(7);
  });

  it('re-pair after the wait leaves the silent partner and finds another guild; the console can break a pact', async () => {
    const { distinct } = serialsByGuild();
    const [a, b, c] = await players(3);
    await toPact(a!.jar, a!.id, distinct[0]!);
    await toPact(b!.jar, b!.id, distinct[1]!);
    expect((await me(a!.jar)).pact.partner!.nickname).toBe('player1');
    t.clock.advance(60_000);
    expect((await call(a!.jar, 'POST', '/api/cipher/pact/repair')).status).toBe(409);
    await toPact(c!.jar, c!.id, distinct[2]!);
    expect((await me(c!.jar)).pact.status).toBe('waiting');
    t.clock.advance(130_000);
    const re = (await call<CipherMe>(a!.jar, 'POST', '/api/cipher/pact/repair')).body;
    expect(re.pact.status).toBe('paired');
    expect(re.pact.partner!.nickname).toBe('player2');
    expect((await me(b!.jar)).pact.status).toBe('waiting');
    // console: break a/c; both go back and pair again (a with b, the only other guild free)
    const admin = await adminJar(t.app);
    const adm = (await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin;
    const open = adm.pacts.find((x) => x.status === 'open')!;
    expect(adm.players.find((p) => p.nickname === 'player0')!.pact).toBe('player2');
    expect((await req(t.app, admin, 'POST', `/api/cipher/admin/pacts/${open.id}/break`)).statusCode).toBe(200);
    const after = (await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin;
    expect(after.pacts.filter((x) => x.status === 'open')).toHaveLength(1);
    expect(after.waiting).toHaveLength(1);
  });

  it('concurrency: twelve players reach the pact at once; nobody is in two pacts, every pact crosses guilds', async () => {
    const ps = await players(12);
    for (const [i, p] of ps.entries()) {
      await throughWinds(p.jar, i + 1);
      await throughEcho(p.jar, i + 1);
      await throughWhisper(p.jar, p.id);
    }
    const ms = await Promise.all(ps.map((p) => me(p.jar)));
    await Promise.all(ps.map((p, i) => call(p.jar, 'POST', '/api/cipher/riddle', { guess: riddleAnswer(slip(i + 1, 3), ms[i]!.riddle.rule!)!.word })));
    await Promise.all(ps.map((p) => me(p.jar)));
    const open = all<{ a_id: number; b_id: number }>(t.ctx.db, "SELECT a_id, b_id FROM cipher_pacts WHERE status = 'open'");
    const ids = open.flatMap((x) => [x.a_id, x.b_id]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(open.length).toBeGreaterThanOrEqual(5);
    const guild = (id: number) => one<{ guild: string }>(t.ctx.db, 'SELECT guild FROM cipher_players WHERE attendee_id = ?', id)!.guild;
    for (const x of open) expect(guild(x.a_id)).not.toBe(guild(x.b_id));
  });

  it('the pact closed: "next trials open soon"; opening it pairs the waiting', async () => {
    const { distinct } = serialsByGuild();
    const admin = await adminJar(t.app);
    const s = ((await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin).settings;
    await req(t.app, admin, 'PUT', '/api/cipher/admin/settings', { ...s, pactOpen: false });
    const [a, b] = await players(2);
    await toPact(a!.jar, a!.id, distinct[0]!);
    await toPact(b!.jar, b!.id, distinct[1]!);
    expect((await me(a!.jar)).nextSoon).toBe(true);
    await req(t.app, admin, 'PUT', '/api/cipher/admin/settings', { ...s, pactOpen: true });
    const m = await me(a!.jar);
    expect(m.nextSoon).toBe(false);
    expect(m.pact.status).toBe('paired');
  });
});

describe('the last signal', () => {
  /** Two players from two guilds through the pact (sealed with each other). */
  async function toSignal(n: number) {
    const ps = await players(n);
    const serials = serialsByGuild().distinct;
    for (const [i, p] of ps.entries()) await toPact(p.jar, p.id, serials[i % serials.length]! + (i >= serials.length ? 4 : 0));
    // seal every open pact by scanning each other's slip IV
    for (const p of ps) {
      const m = await me(p.jar);
      if (m.pact.status !== 'paired' || m.pact.iScanned) continue;
      const partner = ps.find((x) => x.id !== p.id && m.pact.partner!.nickname === `player${ps.indexOf(x)}`)!;
      await scanWord(p.jar, slip(getSerial(partner.id)!, 4)[m.pact.scanEdge!]);
    }
    return ps;
  }
  const getSerial = (id: number) => one<{ serial: number }>(t.ctx.db, 'SELECT serial FROM cipher_players WHERE attendee_id = ?', id)?.serial ?? null;
  const fire = async (body: Record<string, unknown>) => req(t.app, await adminJar(t.app), 'POST', '/api/cipher/admin/signal', body);

  it('warn, then it goes live by itself; only the projector gets its timing; first N win big, the rest something', async () => {
    const admin = await adminJar(t.app);
    const s = ((await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin).settings;
    await req(t.app, admin, 'PUT', '/api/cipher/admin/settings', { ...s, signalFirstN: 1 });
    const ps = await toSignal(2);
    for (const p of ps) expect((await me(p.jar)).trial).toBe(7);
    expect((await fire({ action: 'warn', inSec: 300, word: 'comet' })).statusCode).toBe(200);
    const warned = await me(ps[0]!.jar);
    expect(warned.signal.status).toBe('warned');
    expect(warned.nextSoon).toBe(false);
    expect((await call(ps[0]!.jar, 'POST', '/api/cipher/signal', { guess: 'COMET' })).status).toBe(409);
    t.clock.advance(301_000);
    const scr = (await req(t.app, admin, 'GET', '/api/cipher/screen')).json() as CipherScreen;
    expect(scr.signal.status).toBe('live');
    expect(scr.signalPlay!.segments.length).toBeGreaterThan(20); // looped
    const live = await me(ps[0]!.jar);
    expect(live.signal).toMatchObject({ status: 'live', eligible: true, letters: 5, word: null });
    expect((await call<GuessResult>(ps[0]!.jar, 'POST', '/api/cipher/signal', { guess: 'comit' })).body.correct).toBe(false);
    const first = await call<GuessResult>(ps[0]!.jar, 'POST', '/api/cipher/signal', { guess: 'comet' });
    expect(first.body).toMatchObject({ correct: true, points: P.signalFirst });
    const second = await call<GuessResult>(ps[1]!.jar, 'POST', '/api/cipher/signal', { guess: 'COMET' });
    expect(second.body).toMatchObject({ correct: true, points: P.signalCorrect });
    expect(second.body.me.trial).toBe(8);
    // the word never reached a phone before the reveal
    expect(responses.join('\n').toUpperCase()).not.toMatch(/"COMET"/);
    // close: the guild with the most points per member wins, its members get the crown
    expect((await fire({ action: 'close' })).statusCode).toBe(200);
    const closed = (await req(t.app, admin, 'GET', '/api/cipher/screen')).json() as CipherScreen;
    const winner = closed.signal.winner!;
    expect(winner).toBe(closed.guilds.find((g) => g.rank === 1)!.guild);
    const winnerId = ps.find((p) => one<{ guild: string }>(t.ctx.db, 'SELECT guild FROM cipher_players WHERE attendee_id = ?', p.id)!.guild === winner)!;
    expect(one(t.ctx.db, "SELECT 1 AS x FROM points_ledger WHERE attendee_id = ? AND ref LIKE 'champion:%'", winnerId.id)).toBeTruthy();
    expect(one(t.ctx.db, "SELECT 1 AS x FROM sticker_unlocks WHERE attendee_id = ? AND sticker_id = 'cipher-champion'", winnerId.id)).toBeTruthy();
    expect((await call(ps[0]!.jar, 'POST', '/api/cipher/signal', { guess: 'COMET' })).status).toBe(409);
    await fire({ action: 'reveal' });
    expect((await me(ps[0]!.jar)).signal.word).toBe('COMET');
  });

  it('only players who sealed the pact may answer; first-N under a race; guild maths is points per member', async () => {
    const ps = await toSignal(4);
    const [late] = await players(1);
    await scanWord(late!.jar, slip(12, 1).bottom);
    await fire({ action: 'fire', word: 'NOVA' });
    expect((await call(late!.jar, 'POST', '/api/cipher/signal', { guess: 'NOVA' })).status).toBe(409);
    const rs = await Promise.all(ps.map((p) => call<GuessResult>(p.jar, 'POST', '/api/cipher/signal', { guess: 'nova' })));
    const ranks = all<{ rank: number }>(t.ctx.db, 'SELECT rank FROM cipher_answers ORDER BY rank').map((r) => r.rank);
    expect(ranks).toEqual([1, 2, 3, 4]);
    expect(rs.filter((r) => r.body.points === P.signalFirst + 0)).toHaveLength(4); // firstN 10
    const st = standings(t.ctx);
    for (const g of st) expect(g.average).toBeCloseTo(g.members ? g.points / g.members : 0, 1);
    // the window closes the signal by itself
    t.clock.advance(DEFAULT_CIPHER_SETTINGS.signalWindowSec * 1000 + 1000);
    expect((await me(ps[0]!.jar)).signal.status).toBe('closed');
  });

  it('warn can be called off; a second warn while one is open is refused', async () => {
    expect((await fire({ action: 'warn', inSec: 120 })).statusCode).toBe(200);
    expect((await fire({ action: 'warn', inSec: 120 })).statusCode).toBe(409);
    expect((await fire({ action: 'cancel' })).statusCode).toBe(200);
    expect(all(t.ctx.db, 'SELECT * FROM cipher_signals')).toHaveLength(0);
    expect((await fire({ action: 'fire', word: 'ab!' })).statusCode).toBe(400);
  });
});

describe('the gate and the views', () => {
  it('the projector shows the guild race and the trial heat; the console the progress', async () => {
    const ps = await players(4);
    for (const [i, p] of ps.entries()) await throughWinds(p.jar, i + 1);
    const admin = await adminJar(t.app);
    const screen = (await req(t.app, admin, 'GET', '/api/cipher/screen')).json() as { guilds: { guild: string; members: number; average: number }[]; onTrial: number[] };
    expect(screen.guilds.map((g) => g.guild)).toEqual([...GUILDS]);
    expect(screen.guilds.every((g) => g.members === 1)).toBe(true);
    expect(screen.onTrial).toHaveLength(7);
    expect(screen.onTrial[2]).toBe(4);
    const adm = (await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin;
    expect(adm.players).toHaveLength(4);
    expect(adm.players[0]!.trial).toBe(3);
    expect(adm.set!.claimed).toBe(4);
    const s = { ...adm.settings, echoTries: 4 };
    expect((await req(t.app, admin, 'PUT', '/api/cipher/admin/settings', s)).statusCode).toBe(200);
    expect(((await req(t.app, admin, 'GET', '/api/cipher/admin')).json() as CipherAdmin).settings.echoTries).toBe(4);
    expect((await req(t.app, admin, 'PUT', '/api/cipher/admin/settings', { ...s, oracle: { ...s.oracle, left: 'MMMMMM' } })).statusCode).toBe(400);
    const csv = (await req(t.app, admin, 'GET', '/api/cipher/admin/answer-key.csv')).body;
    const lines = csv.split('\n').filter(Boolean);
    expect(lines).toHaveLength(13);
    expect(lines[0]).toContain('IV_left');
    expect(csv).toContain(whisperOf(ps[0]!.id));
    expect(csv).toContain(slip(3, 3).top);
    expect((await req(t.app, ps[0]!.jar, 'GET', '/api/cipher/admin')).statusCode).toBe(401);
    expect((await req(t.app, ps[0]!.jar, 'GET', '/api/cipher/screen')).statusCode).toBe(401);
  });

  it('visibility: hidden means no scanning and no state, and comes back on', async () => {
    const [a] = await players(1);
    const admin = await adminJar(t.app);
    await req(t.app, admin, 'PUT', '/api/cipher/admin/visible', { enabled: false });
    expect((await me(a!.jar)).visible).toBe(false);
    expect((await scanWord(a!.jar, slip(1, 1).bottom)).status).toBe(403);
    expect((await call(a!.jar, 'POST', '/api/cipher/oath')).status).toBe(403);
    await req(t.app, admin, 'PUT', '/api/cipher/admin/visible', { enabled: true });
    expect((await scanWord(a!.jar, slip(1, 1).bottom)).body.outcome).toBe('claimed');
  });

  it('no ticket set yet: not ready, and scanning says so', async () => {
    t.ctx.db.exec("UPDATE hunt_trails SET title = 'something else'");
    const [a] = await players(1);
    expect((await me(a!.jar)).ready).toBe(false);
    expect((await scanWord(a!.jar, 'ABC')).status).toBe(409);
  });

  it('reset wipes cipher progress and points, keeps the claims', async () => {
    const [a] = await players(1);
    await throughWinds(a!.jar, 1);
    const admin = await adminJar(t.app);
    expect((await req(t.app, admin, 'POST', '/api/cipher/admin/reset', { confirm: 'RESET CIPHER' })).statusCode).toBe(200);
    expect(all(t.ctx.db, 'SELECT * FROM cipher_seals')).toHaveLength(0);
    const m = await me(a!.jar);
    expect(m.ticket!.serial).toBe(1);
    expect(m.trial).toBe(1);
    expect(m.points).toBe(0);
  });
});
