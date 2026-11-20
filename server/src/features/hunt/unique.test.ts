// Unique slips (docs/SLIPS.md, "unique slips"): the word generator, claiming on first scan, outcomes on
// every orientation of every copy, typed vs scanned readings, release, the console API, the live
// migration (shared -> unique), the seed, and the K-of-M trail option.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarFromSeed } from '@afterhours/shared';
import { type HuntAdmin, type HuntMe, type HuntSlipResult, type SlipCopies, type SlipPrintSheet, type SlipSetList, slipWordKey } from '@afterhours/shared/features/hunt';
import { type SlipEdge, SLIP_SIZES, edgeCapacity, encodeWord, layoutSlip, reverseReading } from '@afterhours/shared/morse-slip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newToken, sha256 } from '../../core/auth/crypto';
import { all, one, openDb, run } from '../../core/db';
import { runMigrations } from '../../core/migrate';
import { type TestApp, Jar, SRC_ROOT, adminJar, makeApp, req } from '../../../test/helpers';
import { isProfane } from '../polls/words';
import { SLIP_TAKEN, SLIP_UNKNOWN } from './engine';
import { stopSubset } from './rules';
import { SEED_SLIP_COPIES, seedHunt } from './seed';
import { SLIP_BLOCKLIST, TECH_WORDS, type WordSlot, edgeUnitLimit, generateWords, isBlockedWord, withinOneEdit } from './slipwords';
import { claimCopy, convertToUnique } from './unique';

// ---------------------------------------------------------------------------
// the generator (pure)
// ---------------------------------------------------------------------------

/** The seeded slip trail's shape (3 slips) plus the slip hunt's (1 slip), N copies each. */
function seededSlots(n: number): WordSlot[] {
  const shape: [number, SlipEdge[]][] = [
    [1, ['bottom', 'left', 'right', 'top']],
    [2, ['bottom', 'right', 'left']],
    [3, ['bottom', 'top']],
    [4, ['bottom', 'right', 'left']],
  ];
  const slots: WordSlot[] = [];
  for (let c = 0; c < n; c++) for (const [group, edges] of shape) for (const edge of edges) slots.push({ edge, group });
  return slots;
}

describe('unique slip words', () => {
  for (const n of [80, 120]) {
    it(`${n} copies of four slips: unique, fit their edge, no upside-down twins, spaced, clean`, () => {
      const slots = seededSlots(n);
      const words = generateWords(slots, { seed: `test-${n}` });
      expect(words).toHaveLength(slots.length);
      const keys = words.map(slipWordKey);
      // 1. unique across every copy and edge
      expect(new Set(words).size).toBe(words.length);
      expect(new Set(keys).size).toBe(keys.length);
      const keySet = new Set(keys);
      words.forEach((w, i) => {
        const edge = slots[i]!.edge;
        // 4. fits: the generator's limit, the ticket and the card (the renderer lays it out with no error)
        const units = encodeWord(w).units;
        expect(units).toBeLessThanOrEqual(edgeUnitLimit(edge));
        expect(units).toBeLessThanOrEqual(edgeCapacity(edge, SLIP_SIZES.card.widthMm, SLIP_SIZES.card.heightMm));
        expect(units).toBeLessThanOrEqual(edgeCapacity(edge, SLIP_SIZES.ticket.widthMm, SLIP_SIZES.ticket.heightMm));
        // 3. read upside down it is never a word in use, nor itself
        const rev = reverseReading(keys[i]!);
        expect(rev).not.toBe(keys[i]);
        expect(keySet.has(rev)).toBe(false);
        // 5. clean
        expect(isBlockedWord(w)).toBe(false);
        expect(isProfane(w.toLowerCase())).toBe(false);
      });
      // 2. on copies of the same slip, every pair is at least two edits apart
      for (const g of [1, 2, 3, 4]) {
        const mine = keys.filter((_, i) => slots[i]!.group === g);
        for (let a = 0; a < mine.length; a++) for (let b = a + 1; b < mine.length; b++) if (withinOneEdit(mine[a]!, mine[b]!)) throw new Error(`${mine[a]} ~ ${mine[b]}`);
      }
    });
  }

  it('prints on the ticket and the card without errors; short edges get short words', () => {
    const slots = seededSlots(80);
    const words = generateWords(slots, { seed: 'print' });
    for (let i = 0; i < 40; i++) {
      const strips: Partial<Record<SlipEdge, string>> = { [slots[i]!.edge]: words[i]! };
      for (const size of [SLIP_SIZES.ticket, SLIP_SIZES.card]) expect(layoutSlip({ strips, widthMm: size.widthMm, heightMm: size.heightMm }).errors).toEqual([]);
    }
    const shortLens = words.filter((_, i) => slots[i]!.edge === 'left' || slots[i]!.edge === 'right').map((w) => w.length);
    expect(Math.max(...shortLens)).toBeLessThanOrEqual(4);
    // tech words come first, and spread over the copies rather than all on copy 1
    const tech = words.filter((w) => TECH_WORDS.includes(w)).length;
    expect(tech).toBeGreaterThan(100);
    const firstCopyTech = words.slice(0, 12).filter((w) => TECH_WORDS.includes(w)).length;
    expect(firstCopyTech).toBeLessThan(12);
  });

  it('respects words already printed: taken keys, their reversals, and near misses on the same slip', () => {
    const taken = ['CODE', 'LAB', 'SUN'].map(slipWordKey);
    const words = generateWords(
      Array.from({ length: 200 }, () => ({ edge: 'left' as const, group: 'x' })),
      { seed: 's', taken, near: taken.map((k) => ['x', k] as const) },
    );
    for (const w of words) {
      const k = slipWordKey(w);
      expect(taken).not.toContain(k);
      expect(taken).not.toContain(reverseReading(k));
      for (const t of taken) expect(withinOneEdit(t, k)).toBe(false);
    }
  });

  it('the blocklist: polls list words, short slurs, and words whose upside-down strip spells one', () => {
    for (const w of ['FUK', 'SEX', 'ASS', 'KKK', 'FAP', 'LUND', 'MC']) expect(isBlockedWord(w), w).toBe(true);
    for (const w of ['BIT', 'GIT', 'LAB', 'CODE', 'ZUR']) expect(isBlockedWord(w), w).toBe(false);
    // a word whose upside-down reading is blocked is blocked too: find one and check
    // ASS is .- ... ...; its strip read upside down is ... ... -. = SSN. So SSN is never printed.
    expect(reverseReading(slipWordKey('ASS'))).toBe(slipWordKey('SSN'));
    expect(isProfane('ssn')).toBe(false);
    expect(isBlockedWord('SSN')).toBe(true);
    expect(SLIP_BLOCKLIST.length).toBeGreaterThan(50);
    const sample = generateWords(seededSlots(80), { seed: 'clean' });
    for (const w of sample) for (const b of SLIP_BLOCKLIST) expect(w.includes(b), `${w} has ${b}`).toBe(false);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const slots = seededSlots(5);
    expect(generateWords(slots, { seed: 'a' })).toEqual(generateWords(slots, { seed: 'a' }));
    expect(generateWords(slots, { seed: 'a' })).not.toEqual(generateWords(slots, { seed: 'b' }));
  });
});

describe('K of M stops', () => {
  const ids = [11, 12, 13, 14, 15, 16];
  it('each player gets K of the stops before the finale, plus the shared finale', () => {
    const seen = new Map<number, number>();
    const picks = new Set<string>();
    for (let a = 1; a <= 300; a++) {
      const sub = stopSubset('seed', a, ids, 2);
      expect(sub).toHaveLength(3);
      expect(sub.at(-1)).toBe(16);
      expect(new Set(sub).size).toBe(3);
      expect(stopSubset('seed', a, ids, 2)).toEqual(sub); // stable
      for (const s of sub.slice(0, -1)) seen.set(s, (seen.get(s) ?? 0) + 1);
      picks.add(sub.join(','));
    }
    // spread: every stop is used, roughly evenly (300 * 2 / 5 = 120 each)
    for (const s of [11, 12, 13, 14, 15]) expect(seen.get(s)!).toBeGreaterThan(80);
    expect(picks.size).toBe(10); // all C(5,2) subsets occur
  });
  it('off (0) or a K that covers everything means every stop', () => {
    expect(stopSubset('s', 1, ids, 0)).toEqual(ids);
    expect(stopSubset('s', 1, ids, 5)).toEqual(ids);
    expect(stopSubset('s', 1, ids, 9)).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// through the API
// ---------------------------------------------------------------------------

let kitSeq = 0;
function attendee(t: TestApp, nickname: string) {
  const n = ++kitSeq;
  const kitId = `UQ-${String(n).padStart(4, '0')}`;
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
type Who = ReturnType<typeof attendee>;

describe('unique slips on a trail', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
  });
  afterEach(async () => t.close());

  const api = async <T>(who: Jar | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
    const r = await req(t.app, who, method, `/api/hunt${url}`, body);
    return { status: r.statusCode, body: r.json() as T, raw: r.body };
  };
  const slip = async (w: Who, stopId: number, read: { text?: string; morse?: string }) => api<HuntSlipResult>(w.jar, 'POST', '/slip', { stopId, ...read });
  const me = async (w: Who, trail: number) => (await api<HuntMe>(w.jar, 'GET', `?trail=${trail}`)).body;

  /** A graph trail with one unique slip (every outcome) at its start, like the seeded slip 1. */
  async function uniqueTrail(copies = 10) {
    const tr = (await api<HuntAdmin>(admin, 'POST', '/admin/trails', { title: 'unique', kind: 'morse', orderMode: 'graph' })).body.trail.id;
    const other = (await api<HuntAdmin>(admin, 'POST', '/admin/trails', { title: 'side quest', orderMode: 'fixed' })).body.trail.id;
    for (const x of ['o1', 'o2']) await api(admin, 'POST', `/admin/stops?trail=${other}`, { title: x, clue: 'c', answers: [x] });
    await api(admin, 'PUT', `/admin/state?trail=${other}`, { status: 'open' });
    const sets = (await api<SlipSetList>(admin, 'POST', `/admin/slip-sets?trail=${tr}`, { title: 'kit', mode: 'unique', copies })).body;
    const setId = sets.sets[0]!.id;
    expect(sets.sets[0]!.mode).toBe('unique');
    const next = (await api<HuntAdmin>(admin, 'POST', `/admin/stops?trail=${tr}`, { title: 'next', clue: 'c', answers: ['n'], finale: true })).body.stops.at(-1)!;
    const side = (await api<HuntAdmin>(admin, 'POST', `/admin/stops?trail=${tr}`, { title: 'side', clue: 'c', answers: ['s'], finale: true })).body.stops.at(-1)!;
    const r = await api<SlipSetList>(admin, 'POST', `/admin/slip-sets/${setId}/slips`, {
      slipNo: 1,
      label: 'one',
      readings: [
        { orientation: 'bottom', outcome: 'next', targetStopId: next.id },
        { orientation: 'left', outcome: 'branch', targetStopId: side.id },
        { orientation: 'right', outcome: 'clue', clue: 'look up' },
        { orientation: 'top', outcome: 'bonus', bonusPoints: 7 },
        { orientation: 'extra', outcome: 'decoy', message: 'upside down!' },
        { orientation: 'extra', morse: '..- .-.. .-.-', outcome: 'branch', targetTrailId: other },
      ],
    });
    expect(r.status, r.raw).toBe(200);
    const slipId = r.body.sets[0]!.slips[0]!.id;
    const start = (await api<HuntAdmin>(admin, 'POST', `/admin/stops?trail=${tr}`, { title: 'slip stop', clue: 'scan slip 1', slipId })).body.stops.at(-1)!;
    const ids = (await api<HuntAdmin>(admin, 'GET', `/admin?trail=${tr}`)).body.stops.map((x) => x.id);
    await api(admin, 'PUT', `/admin/order?trail=${tr}`, { ids: [start.id, ...ids.filter((x) => x !== start.id)] });
    await api(admin, 'PUT', `/admin/state?trail=${tr}`, { status: 'open' });
    const print = (await api<SlipPrintSheet>(admin, 'GET', `/admin/slip-print?set=${setId}`)).body;
    return { tr, other, setId, slipId, start, next, side, print };
  }
  const copyOf = (print: SlipPrintSheet, serial: number) => print.slips.find((s) => s.serial === serial)!.edges;

  it('prints N copies, each with its own word on every edge', async () => {
    const g = await uniqueTrail(12);
    expect(g.print.mode).toBe('unique');
    expect(g.print.slips.map((s) => s.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const words = g.print.slips.flatMap((s) => Object.values(s.edges).map((e) => e!.word));
    expect(words).toHaveLength(48);
    expect(new Set(words).size).toBe(48);
    // stable: printing again gives the same words
    expect((await api<SlipPrintSheet>(admin, 'GET', `/admin/slip-print?set=${g.setId}`)).body).toEqual(g.print);
  });

  it('every orientation does the same thing on every copy, from different words; typed and scanned match alike', async () => {
    const g = await uniqueTrail();
    const people = [attendee(t, 'a'), attendee(t, 'b')];
    for (const [i, p] of people.entries()) {
      const serial = i + 3;
      const e = copyOf(g.print, serial);
      await api(p.jar, 'POST', '/start', { trailId: g.tr });
      // right: a clue, you stay (this first reading claims the copy). Typed.
      const clue = (await slip(p, g.start.id, { text: e.right!.word })).body;
      expect(clue).toMatchObject({ outcome: 'clue', clue: 'look up', serial });
      // top: a bonus, once. Scanned (Morse only, as the scanner sends when text is null).
      expect((await slip(p, g.start.id, { morse: e.top!.morse })).body).toMatchObject({ outcome: 'bonus', points: 7 });
      expect((await slip(p, g.start.id, { morse: e.top!.morse })).body).toMatchObject({ outcome: 'bonus', points: 0 });
      // the top strip read upside down: the derived decoy, no penalty
      const before = t.ctx.points.total(p.id);
      expect((await slip(p, g.start.id, { morse: reverseReading(e.top!.morse) })).body).toMatchObject({ outcome: 'decoy', message: 'upside down!' });
      expect(t.ctx.points.total(p.id)).toBe(before);
      // a shared explicit sequence still works on a unique slip (no claim needed)
      expect((await slip(p, g.start.id, { morse: '..- .-.. .-.-' })).body).toMatchObject({ outcome: 'branch', unlockedTrailId: g.other });
      // the scanner sends text AND morse when it decoded the letters
      const target = i === 0 ? { r: e.bottom!, stop: g.next.id, outcome: 'next' } : { r: e.left!, stop: g.side.id, outcome: 'branch' };
      const go = (await slip(p, g.start.id, { text: target.r.word, morse: target.r.morse })).body;
      expect(go.outcome).toBe(target.outcome);
      expect(go.me.current!.stopId).toBe(target.stop);
    }
    // the console sees both people's finds on the same readings
    const readings = (await api<SlipSetList>(admin, 'GET', `/admin/slip-sets?trail=${g.tr}`)).body.sets[0]!.slips[0]!.readings;
    expect(readings.find((r) => r.orientation === 'right')!.finds).toBe(2);
    expect(readings.find((r) => r.orientation === 'top')!.finds).toBe(2);
  });

  it('first scan claims; someone else\'s copy is refused; a second copy of the same slip is refused', async () => {
    const g = await uniqueTrail();
    const [a, b] = [attendee(t, 'a'), attendee(t, 'b')];
    for (const p of [a, b]) await api(p.jar, 'POST', '/start', { trailId: g.tr });
    const c1 = copyOf(g.print, 1);
    const c2 = copyOf(g.print, 2);
    // a claims copy 1 with a clue edge
    expect((await slip(a, g.start.id, { text: c1.right!.word })).body).toMatchObject({ outcome: 'clue', serial: 1 });
    expect((await me(a, g.tr)).current!.slip).toMatchObject({ unique: true, serial: 1 });
    // b scans a's copy: refused, nothing happens, no word or outcome leaks
    const refused = await slip(b, g.start.id, { morse: c1.bottom!.morse });
    expect(refused.body).toMatchObject({ outcome: 'taken', message: SLIP_TAKEN, clue: null, stamped: null, serial: null });
    expect(refused.raw).not.toContain(c1.bottom!.word);
    expect(refused.body.me.current!.stopId).toBe(g.start.id);
    // a tries a second copy of the same slip: refused, told which copy is theirs
    const second = (await slip(a, g.start.id, { text: c2.bottom!.word })).body;
    expect(second.outcome).toBe('taken');
    expect(second.serial).toBe(1);
    expect(second.message).toContain('no. 001');
    expect(second.me.current!.stopId).toBe(g.start.id);
    // copy 2 is still free for b
    expect((await slip(b, g.start.id, { text: c2.bottom!.word })).body).toMatchObject({ outcome: 'next', serial: 2 });
    // a's own copy keeps working
    expect((await slip(a, g.start.id, { text: c1.bottom!.word })).body.outcome).toBe('next');
    // unknown readings: the same friendly reply
    const x = attendee(t, 'x');
    await api(x.jar, 'POST', '/start', { trailId: g.tr });
    expect((await slip(x, g.start.id, { text: 'QQQQ' })).body).toMatchObject({ outcome: 'unknown', message: SLIP_UNKNOWN });
    // the console table
    const copies = (await api<SlipCopies>(admin, 'GET', `/admin/slip-sets/${g.setId}/copies`)).body;
    expect(copies.claimed).toBe(2);
    expect(copies.rows[0]!.cells[0]!.claimedBy!.nickname).toBe('a');
    expect(copies.rows[1]!.cells[0]!.claimedBy!.nickname).toBe('b');
    expect(copies.rows[2]!.cells[0]!.claimedBy).toBeNull();
    expect(copies.signedIn).toBe(3);
  });

  it('a race for one copy has exactly one winner', async () => {
    const g = await uniqueTrail();
    const racers = Array.from({ length: 6 }, (_, i) => attendee(t, `r${i}`));
    for (const p of racers) await api(p.jar, 'POST', '/start', { trailId: g.tr });
    const c = copyOf(g.print, 5);
    const results = await Promise.all(racers.map((p) => slip(p, g.start.id, { text: c.right!.word })));
    expect(results.filter((r) => r.body.outcome === 'clue')).toHaveLength(1);
    expect(results.filter((r) => r.body.outcome === 'taken')).toHaveLength(5);
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copies WHERE claimed_by IS NOT NULL')!.n).toBe(1);
    // and at the database level: the conditional claim cannot be won twice
    const copyId = one<{ id: number }>(t.ctx.db, 'SELECT id FROM hunt_slip_copies WHERE slip_id = ? AND serial = 6', g.slipId)!.id;
    const [x, y] = [attendee(t, 'x'), attendee(t, 'y')];
    expect(claimCopy(t.ctx, x.id, copyId)).toMatchObject({ kind: 'mine', fresh: true });
    expect(claimCopy(t.ctx, y.id, copyId)).toEqual({ kind: 'taken' });
    expect(claimCopy(t.ctx, x.id, copyId)).toMatchObject({ kind: 'mine', fresh: false });
    // and one person can never hold two copies of a slip, even straight in SQL
    const other = one<{ id: number }>(t.ctx.db, 'SELECT id FROM hunt_slip_copies WHERE slip_id = ? AND serial = 7', g.slipId)!.id;
    expect(() => run(t.ctx.db, 'UPDATE hunt_slip_copies SET claimed_by = ? WHERE id = ?', x.id, other)).toThrow(/UNIQUE/);
  });

  it('release frees a copy: a lost slip can be replaced', async () => {
    const g = await uniqueTrail();
    const [a, b] = [attendee(t, 'a'), attendee(t, 'b')];
    for (const p of [a, b]) await api(p.jar, 'POST', '/start', { trailId: g.tr });
    const c1 = copyOf(g.print, 1);
    const c9 = copyOf(g.print, 9);
    expect((await slip(a, g.start.id, { text: c1.right!.word })).body.serial).toBe(1);
    // a lost slip 1 and got a spare: refused until the organiser releases the old copy
    expect((await slip(a, g.start.id, { text: c9.right!.word })).body.outcome).toBe('taken');
    const copies = (await api<SlipCopies>(admin, 'GET', `/admin/slip-sets/${g.setId}/copies`)).body;
    const released = (await api<SlipCopies>(admin, 'POST', `/admin/slip-copies/${copies.rows[0]!.cells[0]!.copyId}/release`)).body;
    expect(released.rows[0]!.cells[0]!.claimedBy).toBeNull();
    expect((await slip(a, g.start.id, { text: c9.right!.word })).body).toMatchObject({ outcome: 'clue', serial: 9 });
    // and the released copy is free for someone else
    expect((await slip(b, g.start.id, { text: c1.right!.word })).body).toMatchObject({ outcome: 'clue', serial: 1 });
  });

  it('copies grow and shrink; claimed copies are never dropped; regenerate only while unclaimed; answer key CSV', async () => {
    const g = await uniqueTrail(5);
    const grown = (await api<SlipCopies>(admin, 'POST', `/admin/slip-sets/${g.setId}/copies`, { copies: 8 })).body;
    expect(grown.rows.map((r) => r.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const after = (await api<SlipPrintSheet>(admin, 'GET', `/admin/slip-print?set=${g.setId}`)).body;
    expect(after.slips.slice(0, 5)).toEqual(g.print.slips); // printed copies keep their words
    const a = attendee(t, 'a');
    await api(a.jar, 'POST', '/start', { trailId: g.tr });
    await slip(a, g.start.id, { text: copyOf(after, 8).right!.word });
    expect((await api(admin, 'POST', `/admin/slip-sets/${g.setId}/copies`, { copies: 6 })).status).toBe(409);
    expect((await api(admin, 'POST', `/admin/slip-sets/${g.setId}/copies`, { copies: 8, regenerate: true })).status).toBe(409);
    const csv = await req(t.app, admin, 'GET', `/api/hunt/admin/slip-sets/${g.setId}/answer-key.csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe('serial,slip_no,label,bottom,right,top,left,top_upside_down_morse,claimed_by');
    expect(lines).toHaveLength(9);
    const e1 = copyOf(after, 1);
    expect(lines[1]).toBe(`001,1,one,${e1.bottom!.word},${e1.right!.word},${e1.top!.word},${e1.left!.word},${reverseReading(e1.top!.morse)},`);
    expect(lines[8]!.endsWith(',a')).toBe(true);
    // attendees cannot read the key or the table
    expect((await req(t.app, a.jar, 'GET', `/api/hunt/admin/slip-sets/${g.setId}/answer-key.csv`)).statusCode).toBe(401);
    expect((await api(a.jar, 'GET', `/admin/slip-sets/${g.setId}/copies`)).status).toBe(401);
  });

  it('editing outcomes keeps the printed words; a new edge gets words on every copy', async () => {
    const g = await uniqueTrail(4);
    const r = await api(admin, 'PUT', `/admin/slips/${g.slipId}`, {
      slipNo: 1,
      label: 'one',
      readings: [
        { orientation: 'bottom', outcome: 'decoy', message: 'changed my mind' },
        { orientation: 'left', outcome: 'branch', targetStopId: g.side.id },
        { orientation: 'right', outcome: 'clue', clue: 'look up' },
        { orientation: 'top', outcome: 'bonus', bonusPoints: 7 },
        { orientation: 'extra', outcome: 'decoy', message: 'upside down!' },
      ],
    });
    expect(r.status, r.raw).toBe(200);
    const print = (await api<SlipPrintSheet>(admin, 'GET', `/admin/slip-print?set=${g.setId}`)).body;
    expect(print).toEqual(g.print);
    const a = attendee(t, 'a');
    await api(a.jar, 'POST', '/start', { trailId: g.tr });
    expect((await slip(a, g.start.id, { text: copyOf(print, 2).bottom!.word })).body).toMatchObject({ outcome: 'decoy', message: 'changed my mind' });
  });

  it('validation: an empty extra needs a generated top edge', async () => {
    const g = await uniqueTrail(2);
    const bad = await api(admin, 'PUT', `/admin/slips/${g.slipId}`, { slipNo: 1, readings: [{ orientation: 'bottom', outcome: 'next' }, { orientation: 'extra', outcome: 'decoy' }] });
    expect(bad.status).toBe(400);
  });

  it('reset frees every copy', async () => {
    const g = await uniqueTrail(3);
    const a = attendee(t, 'a');
    await api(a.jar, 'POST', '/start', { trailId: g.tr });
    await slip(a, g.start.id, { text: copyOf(g.print, 1).right!.word });
    await api(admin, 'POST', `/admin/reset?trail=${g.tr}`, { confirm: 'RESET HUNT' });
    expect((await api<SlipCopies>(admin, 'GET', `/admin/slip-sets/${g.setId}/copies`)).body.claimed).toBe(0);
  });

  it('K of M on a shuffled trail: K stops then the finale, totals follow, a stop not yours is not yours', async () => {
    const tr = (await api<HuntAdmin>(admin, 'POST', '/admin/trails', { title: 'cards', kind: 'morse', orderMode: 'shuffled' })).body.trail.id;
    for (const w of ['BYTE', 'CODE', 'LOOP', 'PIXEL', 'RECURSE']) await api(admin, 'POST', `/admin/stops?trail=${tr}`, { title: w, clue: 'c', answers: [w], challenge: 'morse' });
    const set = await api<HuntAdmin>(admin, 'PUT', `/admin/trails/${tr}`, { subsetK: 2 });
    expect(set.body.trail.subsetK).toBe(2);
    await api(admin, 'PUT', `/admin/state?trail=${tr}`, { status: 'open' });
    const stops = set.body.stops;
    const walked = new Map<number, number>();
    for (let i = 0; i < 12; i++) {
      const p = attendee(t, `k${i}`);
      const m0 = (await api<HuntMe>(p.jar, 'POST', '/start', { trailId: tr })).body;
      expect(m0.total).toBe(3);
      expect(m0.current!.total).toBe(3);
      const mine: number[] = [];
      let m = m0;
      while (m.current) {
        const stop = stops.find((s) => s.id === m.current!.stopId)!;
        mine.push(stop.id);
        if (mine.length === 1) {
          // a stop that is not in this player's subset does not count for them
          const notMine = stops.find((s) => !s.isFinal && s.id !== stop.id)!;
          expect((await api(p.jar, 'POST', '/answer', { stopId: notMine.id, answer: notMine.answers[0] })).body).toMatchObject({ result: 'not_yours' });
        }
        m = (await api<{ me: HuntMe }>(p.jar, 'POST', '/answer', { stopId: stop.id, answer: stop.answers[0] })).body.me;
      }
      expect(mine).toHaveLength(3);
      expect(mine.at(-1)).toBe(stops.at(-1)!.id); // everyone shares the finale
      expect(m.finish).not.toBeNull();
      for (const s of mine.slice(0, -1)) walked.set(s, (walked.get(s) ?? 0) + 1);
    }
    expect(walked.size).toBeGreaterThan(2); // people spread over the stops
    // locked once people started
    expect((await api(admin, 'PUT', `/admin/trails/${tr}`, { subsetK: 3 })).status).toBe(409);
  });
});

describe('seed and live migration', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => t.close());

  it('a fresh seed prints the slip trail and the slip hunt as unique sets of 80', () => {
    seedHunt(t.ctx);
    const sets = all<{ id: number; title: string; mode: string; copies: number }>(t.ctx.db, 'SELECT id, title, mode, copies FROM hunt_slip_sets ORDER BY id');
    expect(sets.map((s) => [s.title, s.mode, s.copies])).toEqual([
      ['kit slips', 'unique', SEED_SLIP_COPIES],
      ['kit slip: first location', 'unique', SEED_SLIP_COPIES],
    ]);
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copies')!.n).toBe(4 * SEED_SLIP_COPIES);
    // 9 edges + 1 upside-down extra per trio, 3 edges per hunt slip
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copy_words')!.n).toBe((9 + 1 + 3) * SEED_SLIP_COPIES);
    expect(one<{ n: number }>(t.ctx.db, "SELECT COUNT(*) AS n FROM hunt_slip_readings WHERE word IS NOT NULL AND orientation != 'extra'")!.n).toBe(0);
  });

  it('switches the old shared seeded sets to unique, keeping outcomes and rewording messages', async () => {
    const admin = await adminJar(t.app);
    // the live database: the old seed's shared slip trail
    const tr = run(t.ctx.db, "INSERT INTO hunt_trails (position, kind, title, status, order_mode, shuffle_seed) VALUES (5, 'morse', 'the slip trail', 'open', 'graph', 'x')").lastId;
    const setId = run(t.ctx.db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool) VALUES (?, 'kit slips', 'shared', '[]')", tr).lastId;
    const slipId = run(t.ctx.db, "INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, 1, 'start')", setId).lastId;
    const add = (o: string, word: string | null, morse: string | null, outcome: string, message: string, clue = '') =>
      run(t.ctx.db, 'INSERT INTO hunt_slip_readings (slip_id, orientation, word, morse, outcome, clue, message) VALUES (?, ?, ?, ?, ?, ?, ?)', slipId, o, word, morse, outcome, clue, message).lastId;
    const bottom = add('bottom', 'LAB', null, 'next', 'The bottom edge says LAB. Head to the computer lab path.');
    add('right', 'HINT', null, 'clue', '', 'Every slip has a word you would expect at a tech club. Look for it.');
    add('top', 'NOPE', null, 'decoy', 'NOPE is literally a decoy. Turn it again.');
    const extra = add('extra', null, '. .--. --- .-', 'decoy', 'Upside down! Clever, but that is not a way forward.');
    add('left', 'ZAP', null, 'decoy', 'ZAP! nothing here.');
    const r = await req(t.app, admin, 'PUT', `/api/hunt/admin/slip-sets/${setId}/mode`, { mode: 'unique', copies: 80 });
    expect(r.statusCode, r.body).toBe(200);
    const list = r.json() as SlipSetList;
    expect(list.sets[0]).toMatchObject({ mode: 'unique', copies: 80, claimed: 0 });
    const readings = all<{ id: number; orientation: string; word: string | null; morse: string | null; outcome: string; message: string; clue: string }>(
      t.ctx.db,
      'SELECT id, orientation, word, morse, outcome, message, clue FROM hunt_slip_readings WHERE slip_id = ? ORDER BY id',
      slipId,
    );
    expect(readings.map((x) => [x.orientation, x.word, x.morse, x.outcome])).toEqual([
      ['bottom', null, null, 'next'],
      ['right', null, null, 'clue'],
      ['top', null, null, 'decoy'],
      ['extra', null, null, 'decoy'],
      ['left', null, null, 'decoy'],
    ]);
    expect(readings[0]!.id).toBe(bottom); // ids kept: finds and bonus refs survive
    expect(readings[3]!.id).toBe(extra);
    expect(readings[0]!.message).toBe('The bottom edge sends you down the lab path. Head to the computer lab.');
    expect(readings[1]!.clue).not.toContain('word you would expect');
    expect(readings[4]!.message).toBe('nothing here.');
    for (const x of readings) expect(`${x.message} ${x.clue}`).not.toMatch(/\b(LAB|HINT|NOPE|ZAP)\b/);
    // 80 copies, 4 edges + the derived upside-down top each
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copy_words')!.n).toBe(80 * 5);
    // a second click is harmless (it just keeps 80 copies)
    expect((await req(t.app, admin, 'PUT', `/api/hunt/admin/slip-sets/${setId}/mode`, { mode: 'unique', copies: 80 })).statusCode).toBe(200);
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slip_copy_words')!.n).toBe(80 * 5);
  });

  it('refuses to switch a set people already scanned', () => {
    const tr = run(t.ctx.db, "INSERT INTO hunt_trails (position, kind, title, status, order_mode, shuffle_seed) VALUES (5, 'morse', 't', 'open', 'graph', 'x')").lastId;
    const setId = run(t.ctx.db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool) VALUES (?, 'k', 'shared', '[]')", tr).lastId;
    const slipId = run(t.ctx.db, "INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, 1, '')", setId).lastId;
    const rid = run(t.ctx.db, "INSERT INTO hunt_slip_readings (slip_id, orientation, word, outcome) VALUES (?, 'bottom', 'LAB', 'next')", slipId).lastId;
    run(t.ctx.db, "INSERT INTO kits (id, password_hash, created_at) VALUES ('K', 'x', 1)");
    const aid = run(t.ctx.db, "INSERT INTO attendees (kit_id, nickname, profile_complete, first_signin_at) VALUES ('K', 'a', 1, 1)").lastId;
    run(t.ctx.db, 'INSERT INTO hunt_slip_finds (attendee_id, reading_id, at) VALUES (?, ?, 1)', aid, rid);
    expect(() => convertToUnique(t.ctx, setId, 80)).toThrow(/already scanned/);
    expect(one<{ mode: string }>(t.ctx.db, 'SELECT mode FROM hunt_slip_sets WHERE id = ?', setId)!.mode).toBe('shared');
  });
});

describe('migration 004', () => {
  it('widens the mode check in place: slips, readings, finds and per-kit words survive', () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-unique-'));
    try {
      const huntDir = join(root, 'hunt');
      mkdirSync(huntDir);
      for (const f of ['001_hunt.sql', '002_trails.sql', '003_slips.sql']) copyFileSync(join(SRC_ROOT, 'features/hunt/migrations', f), join(huntDir, f));
      const db = openDb(':memory:');
      const sources = [
        { scope: 'core', dir: join(SRC_ROOT, 'core/migrations') },
        { scope: 'hunt', dir: huntDir },
      ];
      runMigrations(db, sources);
      const set = run(db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool) VALUES (1, 'kit slips', 'shared', '[]')").lastId;
      const pk = run(db, "INSERT INTO hunt_slip_sets (trail_id, title, mode, word_pool) VALUES (1, 'pk', 'per_kit', '[\"A\"]')").lastId;
      const slipId = run(db, "INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, 1, 'start')", set).lastId;
      const pkSlip = run(db, "INSERT INTO hunt_slips (set_id, slip_no, label) VALUES (?, 1, '')", pk).lastId;
      const rid = run(db, "INSERT INTO hunt_slip_readings (slip_id, orientation, word, outcome) VALUES (?, 'bottom', 'LAB', 'next')", slipId).lastId;
      const pkr = run(db, "INSERT INTO hunt_slip_readings (slip_id, orientation, outcome) VALUES (?, 'bottom', 'next')", pkSlip).lastId;
      run(db, "INSERT INTO hunt_kit_slip_words (kit_id, reading_id, word, morse) VALUES ('AH-001', ?, 'A', '.-')", pkr);
      run(db, 'INSERT INTO hunt_slip_finds (attendee_id, reading_id, at) VALUES (1, ?, 5)', rid);
      expect(() => run(db, "UPDATE hunt_slip_sets SET mode = 'unique' WHERE id = ?", set)).toThrow(/CHECK/);
      copyFileSync(join(SRC_ROOT, 'features/hunt/migrations/004_unique_slips.sql'), join(huntDir, '004_unique_slips.sql'));
      expect(runMigrations(db, sources).applied).toEqual(['hunt/004_unique_slips.sql']);
      expect(all(db, 'SELECT id, title, mode, copies FROM hunt_slip_sets ORDER BY id')).toEqual([
        { id: set, title: 'kit slips', mode: 'shared', copies: 0 },
        { id: pk, title: 'pk', mode: 'per_kit', copies: 0 },
      ]);
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM hunt_slips')!.n).toBe(2);
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM hunt_slip_readings')!.n).toBe(2);
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM hunt_slip_finds')!.n).toBe(1);
      expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM hunt_kit_slip_words')!.n).toBe(1);
      run(db, "UPDATE hunt_slip_sets SET mode = 'unique' WHERE id = ?", set);
      expect(() => run(db, "UPDATE hunt_slip_sets SET mode = 'bogus' WHERE id = ?", set)).toThrow(/CHECK/);
      expect(one<{ subset_k: number }>(db, 'SELECT subset_k FROM hunt_trails WHERE id = 1')!.subset_k).toBe(0);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
