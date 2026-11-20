// Player visibility, one switch per event (both off by default): "show treasure hunt to players" (trails of
// kind hunt/other) and "show morse challenge to players" (kind morse). While an event is off its attendee and
// projector APIs refuse, its live events reach only the console and the feed says nothing about it.
// Plus "the morse slip": the standalone one-slip Morse challenge, and its balanced ticket designs.
import type { LiveEnvelope } from '@afterhours/shared';
import type { HuntAdmin, HuntMe, HuntSlipResult, HuntVisibility, MorseSlipSetup, SlipCopies, SlipPrintSheet, TrailList } from '@afterhours/shared/features/hunt';
import { SLIP_SIZES, SLIP_TICKETS, layoutSlip, reverseReading } from '@afterhours/shared/morse-slip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, AVATAR, Jar, adminJar, capture, makeApp, makeKits, req, signedInAttendee } from '../../../test/helpers';
import { createSession } from '../../core/auth/sessions';
import { all, one, run } from '../../core/db';
import { tick as dropsTick } from '../drops/index';
import { MORSE_SLIP_BONUS, MORSE_SLIP_POINTS, MORSE_SLIP_SMALL_BONUS, MORSE_SLIP_TITLE, createMorseSlip, getMorseTicketSet } from './morseSlip';
import { rankBonus } from './rules';
import { seedHunt } from './seed';
import { assignDesigns } from './slipwords';
import { NOT_OPEN_MESSAGE, setVisibility, visibility } from './visibility';

describe('player visibility: one switch per event', () => {
  let t: TestApp;
  let admin: Jar;
  let player: { jar: Jar; id: number };
  let hunt: number;
  let morse: MorseSlipSetup;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    const kits = await makeKits(t.app, 1);
    player = await signedInAttendee(t.app, kits[0]!, 'player');
    // a treasure hunt trail (riddles) and the morse slip
    hunt = (await req(t.app, admin, 'POST', '/api/hunt/admin/trails', { title: 'secret hunt', kind: 'hunt', orderMode: 'fixed' })).json<HuntAdmin>().trail.id;
    for (const w of ['one', 'two']) await req(t.app, admin, 'POST', `/api/hunt/admin/stops?trail=${hunt}`, { title: w, clue: 'c', answers: [w] });
    await req(t.app, admin, 'PUT', `/api/hunt/admin/state?trail=${hunt}`, { status: 'open' });
    morse = (await req(t.app, admin, 'POST', '/api/hunt/admin/morse-slip')).json<MorseSlipSetup>();
  });
  afterEach(async () => t.close());

  const stopOf = async (trail: number) => (await req(t.app, admin, 'GET', `/api/hunt/admin?trail=${trail}`)).json<HuntAdmin>().stops[0]!.id;
  const calls = async (trail: number): Promise<[string, string, object?][]> => {
    const stop = await stopOf(trail);
    return [
      ['GET', `/api/hunt?trail=${trail}`],
      ['POST', '/api/hunt/start', { trailId: trail }],
      ['POST', '/api/hunt/answer', { stopId: stop, answer: 'x' }],
      ['POST', '/api/hunt/hint', { stopId: stop, n: 1 }],
      ['POST', '/api/hunt/slip', { stopId: stop, text: 'LAB' }],
      ['GET', `/api/hunt/board?trail=${trail}`],
    ];
  };
  const refused = async (jar: Jar, list: [string, string, object?][]) => {
    for (const [method, url, body] of list) {
      const r = await req(t.app, jar, method as 'GET', url, body);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json()).toMatchObject({ error: { code: 'not_open', message: NOT_OPEN_MESSAGE } });
      expect(r.body).not.toMatch(/secret hunt|the morse slip/);
    }
  };

  it('both are off on a fresh database: every attendee and projector API for either event refuses', async () => {
    expect(visibility(t.ctx)).toEqual({ hunt: false, morse: false });
    expect((await req(t.app, null, 'GET', '/api/hunt/visibility')).json()).toEqual({ hunt: false, morse: false });
    await refused(player.jar, [['GET', '/api/hunt/trails'], ['GET', '/api/hunt/trails?group=hunt'], ['GET', '/api/hunt/trails?group=morse'], ['POST', '/api/hunt/scan', { code: 'ABCD-EFGH' }]]);
    await refused(player.jar, await calls(hunt));
    await refused(player.jar, await calls(morse.trailId));
    const screen = new Jar();
    screen.cookies.ah_screen = createSession(t.ctx, 'screen', null).token;
    expect((await req(t.app, screen, 'GET', `/api/hunt/board?trail=${hunt}`)).statusCode).toBe(403);
    // the console sees and edits everything
    expect((await req(t.app, admin, 'GET', '/api/hunt/admin/trails')).statusCode).toBe(200);
    expect((await req(t.app, admin, 'PUT', `/api/hunt/admin/trails/${hunt}`, { title: 'still secret' })).statusCode).toBe(200);
    // attendees cannot flip a switch
    expect((await req(t.app, player.jar, 'PUT', '/api/hunt/admin/visibility', { morse: true })).statusCode).toBe(401);
    expect(visibility(t.ctx)).toEqual({ hunt: false, morse: false });
  });

  it('morse only: the morse slip plays, the treasure hunt leaves no trace (API, live events, feed)', async () => {
    const phone = capture(t.ctx, { attendeeId: player.id, admin: false, screen: false });
    const on = await req(t.app, admin, 'PUT', '/api/hunt/admin/visibility', { morse: true });
    expect(on.json<HuntVisibility>()).toEqual({ hunt: false, morse: true });
    expect((phone.events.find((e) => e.type === 'hunt.visibility') as LiveEnvelope<'hunt.visibility'>).data).toEqual({ hunt: false, morse: true });
    // the trail list: only morse trails, and the hunt group refuses
    const list = (await req(t.app, player.jar, 'GET', '/api/hunt/trails')).json<TrailList>();
    expect(list.trails.map((x) => x.title)).toEqual([MORSE_SLIP_TITLE]);
    expect((await req(t.app, player.jar, 'GET', '/api/hunt/trails?group=morse')).json<TrailList>().trails.map((x) => x.kind)).toEqual(['morse']);
    await refused(player.jar, [['GET', '/api/hunt/trails?group=hunt']]);
    await refused(player.jar, await calls(hunt));
    expect((await req(t.app, player.jar, 'POST', '/api/hunt/start', { trailId: morse.trailId })).statusCode).toBe(200);
    // hunt events stay in the console; morse ones reach phones
    const console_ = capture(t.ctx, { attendeeId: null, admin: true, screen: false });
    await req(t.app, admin, 'PUT', `/api/hunt/admin/state?trail=${hunt}`, { status: 'closed' });
    await req(t.app, admin, 'PUT', `/api/hunt/admin/state?trail=${hunt}`, { status: 'open' });
    t.ctx.live.publish('hunt.stamp', { trailId: hunt, nickname: 'x', avatar: AVATAR, solved: 1, total: 2, at: t.ctx.now() }, 'screens');
    await req(t.app, admin, 'PUT', `/api/hunt/admin/trails/${morse.trailId}`, { title: MORSE_SLIP_TITLE });
    dropsTick(t.ctx);
    t.clock.advance(60_000);
    dropsTick(t.ctx);
    const huntEvents = phone.events.filter((e) => e.type.startsWith('hunt.') && (e.data as { trailId?: number }).trailId === hunt);
    expect(huntEvents).toEqual([]);
    expect(phone.events.some((e) => e.type === 'hunt.state' && (e.data as { trailId: number }).trailId === morse.trailId)).toBe(true);
    expect(console_.events.some((e) => e.type === 'hunt.state' && (e.data as { trailId: number }).trailId === hunt)).toBe(true);
    const feed = phone.events.filter((e) => e.type === 'drops.feed') as LiveEnvelope<'drops.feed'>[];
    expect(feed.flatMap((f) => f.data.items.map((i) => i.text)).join(' ')).not.toMatch(/secret hunt|found stop/);
    phone.unsub();
    console_.unsub();
  });

  it('hunt only, the other way round: the morse slip leaves no trace', async () => {
    await req(t.app, admin, 'PUT', '/api/hunt/admin/visibility', { hunt: true });
    const list = (await req(t.app, player.jar, 'GET', '/api/hunt/trails')).json<TrailList>();
    expect(list.trails.map((x) => x.kind)).toEqual(['hunt']);
    await refused(player.jar, [['GET', '/api/hunt/trails?group=morse']]);
    await refused(player.jar, await calls(morse.trailId));
    expect((await req(t.app, player.jar, 'POST', '/api/hunt/start', { trailId: hunt })).statusCode).toBe(200);
    // and off again hides it again, live
    const phone = capture(t.ctx, { attendeeId: player.id, admin: false, screen: false });
    await req(t.app, admin, 'PUT', '/api/hunt/admin/visibility', { hunt: false });
    expect((phone.events.at(-1) as LiveEnvelope<'hunt.visibility'>).data).toEqual({ hunt: false, morse: false });
    await refused(player.jar, await calls(hunt));
    phone.unsub();
  });

  it('a switch publishes only on a change', () => {
    const c = capture(t.ctx, { attendeeId: null, admin: false, screen: false });
    setVisibility(t.ctx, { hunt: false });
    expect(c.types()).toEqual([]);
    setVisibility(t.ctx, { morse: true });
    setVisibility(t.ctx, { morse: true });
    expect(c.types()).toEqual(['hunt.visibility']);
    c.unsub();
  });
});

describe('the morse slip: one unique slip per participant', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    setVisibility(t.ctx, { morse: true });
  });
  afterEach(async () => t.close());

  it('creates one open graph trail: one slip stop (the finale) reading four tickets I-IV x 80; a second call changes nothing', async () => {
    const a = (await req(t.app, admin, 'POST', '/api/hunt/admin/morse-slip')).json<MorseSlipSetup>();
    expect(a.created).toBe(true);
    const b = (await req(t.app, admin, 'POST', '/api/hunt/admin/morse-slip')).json<MorseSlipSetup>();
    expect(b).toEqual({ ...a, created: false });
    expect(getMorseTicketSet(t.ctx)).toBe(a.setId);
    const adm = (await req(t.app, admin, 'GET', `/api/hunt/admin?trail=${a.trailId}`)).json<HuntAdmin>();
    expect(adm.trail).toMatchObject({ kind: 'morse', orderMode: 'graph', status: 'open', title: MORSE_SLIP_TITLE });
    expect(adm.stops).toHaveLength(1);
    expect(adm.stops[0]).toMatchObject({ challenge: 'slip', finale: true, points: MORSE_SLIP_POINTS });
    const copies = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-sets/${a.setId}/copies`)).json<SlipCopies>();
    expect(copies.copies).toBe(80);
    expect(copies.slips.map((x) => x.slipNo)).toEqual([1, 2, 3, 4]);
    // slip I is the guild: 20 of each design over the 80 serials
    const guild = copies.rows.map((r) => r.cells[0]!.design);
    for (const d of SLIP_TICKETS) expect(guild.filter((x) => x === d)).toHaveLength(20);
    // every serial (one page, one participant) holds all four designs, once each
    for (const r of copies.rows) expect(new Set(r.cells.map((c) => c.design)).size).toBe(4);
    // the print sheet: serial order, slips I-IV of a serial together, the four-per-page size, the designs
    const sheet = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-print?set=${a.setId}`)).json<SlipPrintSheet>();
    expect(sheet.size).toBe('quad');
    expect(sheet.slips).toHaveLength(320);
    expect(sheet.slips.slice(0, 8).map((x) => [x.serial, x.slipNo])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [2, 1],
      [2, 2],
      [2, 3],
      [2, 4],
    ]);
    expect(sheet.slips.slice(0, 4).map((x) => x.ticket)).toEqual(copies.rows[0]!.cells.map((c) => c.design));
    // every edge of every ticket has its own word, 3 or 4 letters
    const words = sheet.slips.flatMap((x) => Object.values(x.edges).map((e) => e!.word));
    expect(words).toHaveLength(1280);
    expect(new Set(words).size).toBe(1280);
    for (const w of words) expect(w.length >= 3 && w.length <= 4, w).toBe(true);
    // and they print at the four-per-page size with dots of at least 1.3 mm
    for (const x of sheet.slips.slice(0, 40)) {
      const L = layoutSlip({ strips: Object.fromEntries(Object.entries(x.edges).map(([k, e]) => [k, e!.word])), widthMm: SLIP_SIZES.quad.widthMm, heightMm: SLIP_SIZES.quad.heightMm });
      expect(L.errors).toEqual([]);
      for (const st of L.strips) expect(st.unitMm).toBeGreaterThanOrEqual(1.3);
    }
    // the answer key shows each copy's design
    const csv = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-sets/${a.setId}/answer-key.csv`)).body.trim().split('\n');
    expect(csv[0]).toBe('serial,slip_no,label,design,bottom,right,top,left,top_upside_down_morse,claimed_by');
    expect(csv).toHaveLength(321);
    expect(csv[1]!.split(',')[3]).toBe(guild[0]);
  });

  it("ticket I: bottom finishes, left pays once, right clue, top and upside down decoys; II-IV read at the same stop; a serial is one person's", async () => {
    const m = createMorseSlip(t.ctx);
    const sheet = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-print?set=${m.setId}`)).json<SlipPrintSheet>();
    const ticket = (serial: number, slipNo: number) => sheet.slips.find((x) => x.serial === serial && x.slipNo === slipNo)!.edges;
    const stop = (await req(t.app, admin, 'GET', `/api/hunt/admin?trail=${m.trailId}`)).json<HuntAdmin>().stops[0]!.id;
    const kits = await makeKits(t.app, 2);
    const a = await signedInAttendee(t.app, kits[0]!, 'ana');
    const b = await signedInAttendee(t.app, kits[1]!, 'bo');
    const slip = (who: { jar: Jar }, read: object) => req(t.app, who.jar, 'POST', '/api/hunt/slip', { stopId: stop, ...read });
    for (const p of [a, b]) expect((await req(t.app, p.jar, 'POST', '/api/hunt/start', { trailId: m.trailId })).json<HuntMe>().current!.slip).toMatchObject({ unique: true, serial: null });
    const before = t.ctx.points.total(a.id);
    // ana starts with ticket III of serial 7: that reserves serial 7 for her
    expect((await slip(a, { text: ticket(7, 3).right!.word })).json<HuntSlipResult>()).toMatchObject({ outcome: 'bonus', points: MORSE_SLIP_SMALL_BONUS, serial: 7 });
    expect((await req(t.app, a.jar, 'GET', `/api/hunt?trail=${m.trailId}`)).json<HuntMe>().current!.slip).toMatchObject({ serial: 7 });
    // bo cannot use any ticket of serial 7, even one ana has not scanned yet
    expect((await slip(b, { text: ticket(7, 2).bottom!.word })).json<HuntSlipResult>()).toMatchObject({ outcome: 'taken', stamped: null });
    // and ana cannot use another serial's tickets
    const other = (await slip(a, { text: ticket(9, 2).bottom!.word })).json<HuntSlipResult>();
    expect(other).toMatchObject({ outcome: 'taken', serial: 7 });
    expect(other.message).toContain('no. 007');
    // II and IV of her own serial
    expect((await slip(a, { text: ticket(7, 2).right!.word })).json<HuntSlipResult>().outcome).toBe('clue');
    expect((await slip(a, { text: ticket(7, 4).top!.word })).json<HuntSlipResult>().outcome).toBe('decoy');
    // ticket I
    const mine = ticket(7, 1);
    expect((await slip(a, { text: mine.right!.word })).json<HuntSlipResult>()).toMatchObject({ outcome: 'clue', serial: 7 });
    expect((await slip(a, { morse: mine.left!.morse })).json<HuntSlipResult>()).toMatchObject({ outcome: 'bonus', points: MORSE_SLIP_BONUS });
    expect((await slip(a, { morse: mine.left!.morse })).json<HuntSlipResult>()).toMatchObject({ outcome: 'bonus', points: 0 });
    expect((await slip(a, { text: mine.top!.word })).json<HuntSlipResult>().outcome).toBe('decoy');
    expect((await slip(a, { morse: reverseReading(mine.top!.morse) })).json<HuntSlipResult>().outcome).toBe('decoy');
    const done = (await slip(a, { text: mine.bottom!.word, morse: mine.bottom!.morse })).json<HuntSlipResult>();
    expect(done.outcome).toBe('next');
    expect(done.stamped).toMatchObject({ title: 'your morse tickets', points: MORSE_SLIP_POINTS });
    expect(done.finish).toMatchObject({ rank: 1, rankBonus: rankBonus(1) });
    expect(done.me.current).toBeNull();
    expect(t.ctx.points.total(a.id) - before).toBe(MORSE_SLIP_POINTS + MORSE_SLIP_BONUS + MORSE_SLIP_SMALL_BONUS + rankBonus(1) + done.finish!.speedBonus);
    // bo, on his own serial, finishes second
    expect((await slip(b, { text: ticket(12, 1).bottom!.word })).json<HuntSlipResult>().finish!.rank).toBe(2);
  });

  it('rebuilds an older one-ticket set into four tickets x 80, only while nothing is claimed', async () => {
    // the live database: "the morse slip" made before tickets II-IV existed (one slip x 80)
    const m = createMorseSlip(t.ctx);
    run(t.ctx.db, 'DELETE FROM hunt_slips WHERE set_id = ? AND slip_no > 1', m.setId);
    expect(one<{ n: number }>(t.ctx.db, 'SELECT COUNT(*) AS n FROM hunt_slips WHERE set_id = ?', m.setId)!.n).toBe(1);
    const r = await req(t.app, admin, 'POST', '/api/hunt/admin/morse-slip/rebuild');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<MorseSlipSetup>()).toEqual({ trailId: m.trailId, setId: m.setId, created: false });
    const copies = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-sets/${m.setId}/copies`)).json<SlipCopies>();
    expect(copies.slips.map((x) => x.label)).toEqual(['ticket I', 'ticket II', 'ticket III', 'ticket IV']);
    expect(copies.rows).toHaveLength(80);
    const stop = (await req(t.app, admin, 'GET', `/api/hunt/admin?trail=${m.trailId}`)).json<HuntAdmin>().stops[0]!;
    expect(stop.slipId).toBe(copies.slips[0]!.id);
    // someone claims a ticket: no more rebuilding
    const [kit] = await makeKits(t.app, 1);
    const p = await signedInAttendee(t.app, kit!, 'pat');
    await req(t.app, p.jar, 'POST', '/api/hunt/start', { trailId: m.trailId });
    const sheet = (await req(t.app, admin, 'GET', `/api/hunt/admin/slip-print?set=${m.setId}`)).json<SlipPrintSheet>();
    await req(t.app, p.jar, 'POST', '/api/hunt/slip', { stopId: stop.id, text: sheet.slips[0]!.edges.right!.word });
    expect((await req(t.app, admin, 'POST', '/api/hunt/admin/morse-slip/rebuild')).statusCode).toBe(409);
    expect((await req(t.app, p.jar, 'POST', '/api/hunt/admin/morse-slip/rebuild')).statusCode).toBe(401);
  });

  it('a single stop can open only when it is a slip stop', async () => {
    const tr = (await req(t.app, admin, 'POST', '/api/hunt/admin/trails', { title: 'one riddle', kind: 'morse', orderMode: 'graph' })).json<HuntAdmin>().trail.id;
    await req(t.app, admin, 'POST', `/api/hunt/admin/stops?trail=${tr}`, { title: 'r', clue: 'c', answers: ['x'], finale: true });
    expect((await req(t.app, admin, 'PUT', `/api/hunt/admin/state?trail=${tr}`, { status: 'open' })).statusCode).toBe(409);
  });

  it('the seed: the morse slip is open, the venue morse trail, the 3-slip trail and the slip hunt are drafts, both switches off', () => {
    seedHunt(t.ctx);
    setVisibility(t.ctx, { morse: false });
    const trails = all<{ title: string; kind: string; status: string }>(t.ctx.db, 'SELECT title, kind, status FROM hunt_trails ORDER BY id');
    expect(trails).toEqual([
      { title: 'the after hours hunt', kind: 'hunt', status: 'open' },
      { title: 'the morse trail', kind: 'morse', status: 'draft' },
      { title: 'the slip trail', kind: 'morse', status: 'draft' },
      { title: 'the slip hunt', kind: 'other', status: 'draft' },
      { title: MORSE_SLIP_TITLE, kind: 'morse', status: 'open' },
    ]);
    // the treasure hunt does not depend on any kit slip
    expect(all(t.ctx.db, "SELECT s.id FROM hunt_stops s JOIN hunt_trails tr ON tr.id = s.trail_id WHERE tr.kind = 'hunt' AND s.challenge = 'slip'")).toEqual([]);
    expect(visibility(t.ctx)).toEqual({ hunt: false, morse: false });
  });
});

describe('ticket designs for unique copies', () => {
  const D = SLIP_TICKETS;
  const empty = (n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, null] as [number, null]));
  const counts = (m: Map<number, string>) => D.map((d) => [...m.values()].filter((x) => x === d).length);

  it('balanced for any N: 20 each for 80, never more than one apart', () => {
    expect(counts(assignDesigns(D, empty(80), 's'))).toEqual([20, 20, 20, 20]);
    for (const n of [1, 3, 7, 81, 83, 150]) {
      const c = counts(assignDesigns(D, empty(n), 's'));
      expect(c.reduce((a, b) => a + b)).toBe(n);
      expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
    }
  });

  it('deterministic per set; mixed, not in blocks; growing keeps every printed design and stays balanced', () => {
    const a = assignDesigns(D, empty(80), 'design:5:9');
    expect(assignDesigns(D, empty(80), 'design:5:9')).toEqual(a);
    expect(assignDesigns(D, empty(80), 'design:6:9')).not.toEqual(a);
    // pages of three are not all one design throughout
    const pagesMixed = Array.from({ length: 26 }, (_, p) => new Set([1, 2, 3].map((k) => a.get(p * 3 + k))).size > 1).filter(Boolean).length;
    expect(pagesMixed).toBeGreaterThan(15);
    const grown = new Map<number, (typeof D)[number] | null>([...a.entries(), ...[81, 82, 83, 84, 85].map((s) => [s, null] as [number, null])]);
    const b = assignDesigns(D, grown, 'design:5:9');
    for (const [s, d] of a) expect(b.get(s)).toBe(d);
    const c = counts(b);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
  });
});
