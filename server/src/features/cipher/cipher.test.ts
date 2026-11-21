// The Cipher Ticket: every trial's server rules, concurrency and the visibility gate.
import { type CipherAdmin, type CipherMe, type EchoResult, type GuessResult, type ScanResult, DEFAULT_CIPHER_SETTINGS, GUILDS } from '@afterhours/shared/features/cipher';
import { slipWordKey } from '@afterhours/shared/features/hunt';
import { reverseReading } from '@afterhours/shared/morse-slip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, type Jar, adminJar, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { all, one } from '../../core';
import { judgeEcho, riddleAnswer } from './service';
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
