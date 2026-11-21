// Student-ID login, end to end on the API. Made-up people only: nothing here is from the real roster.
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importParticipants, parseParticipantCsv } from '../src/core/auth/participants';
import { all, one } from '../src/core/db';
import { AVATAR, type Jar, type TestApp, Jar as JarClass, adminJar, capture, gateJar, makeApp, makeKits, req, signedInAttendee } from './helpers';
import { setVisibility } from '../src/features/hunt/visibility';

// These tests pin the one-phone-per-ID rule, which is OFF by default on event day (AH_ONE_PHONE=1 brings it back).
beforeAll(() => {
  process.env.AH_ONE_PHONE = '1';
});
afterAll(() => {
  delete process.env.AH_ONE_PHONE;
});

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROSTER = [
  'name,year,section,roll,phone,email',
  'Asha Verma,2nd,CSE-A,25BD1A0533,9000000011,asha@example.com',
  'Bhavya Datta,1st,CSE-B,26BD1A0533,9000000022,bhavya@example.com',
  'Chetan Rao,2nd,CSE-C,25BD1A0577,9000000033,chetan@example.com',
  'Chandana Rao,1st,CSE-C,26BD1A0577,9000000044,chandana@example.com',
  'Divya Kapoor,1st,CSM-A,26BD1A660K,9000000055,divya@example.com',
  'Eshan Mehta,1st,CSE-D,26BD1A05E7,9000000066,eshan@example.com',
].join('\n');

const DIVYA_QR = '660K-12600-A-KAPOOR-CSM-260908';

describe('student-ID login', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    setVisibility(t.ctx, { hunt: true, morse: true }); // both events are hidden from players by default
    admin = await adminJar(t.app);
    const r = await req(t.app, admin, 'POST', '/api/admin/participants/import', { csv: ROSTER });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as J).added).toBe(6);
  });
  afterEach(async () => t.close());

  const phone = () => new JarClass();
  const resolve = (jar: Jar, payload: string, pick?: number) => req(t.app, jar, 'POST', '/api/auth/id/resolve', { payload, ...(pick !== undefined ? { pick } : {}) });
  const idSignIn = (jar: Jar, body: J) => req(t.app, jar, 'POST', '/api/auth/id/signin', body);
  const rollSignIn = (jar: Jar, roll: string, phone4: string) => req(t.app, jar, 'POST', '/api/auth/roll/signin', { roll, phone4 });
  const list = async () => (await req(t.app, admin, 'GET', '/api/admin/participants')).json() as J;
  const byRoll = async (roll: string) => (await list()).participants.find((p: J) => p.roll === roll);

  describe('QR scan', () => {
    it('resolves, confirms and signs in: a normal attendee prefilled with name and roll', async () => {
      const jar = phone();
      const r = await resolve(jar, DIVYA_QR);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ kind: 'one', id: expect.any(Number), firstName: 'Divya', year: '1st', section: 'CSM-A', needPhone: false, thisPhone: false });
      // resolving changes nothing
      expect((await byRoll('26BD1A660K')).attendee).toBeNull();
      const s = await idSignIn(jar, { payload: DIVYA_QR });
      expect(s.statusCode, s.body).toBe(200);
      const me = s.json() as J;
      expect(me.attendee).toMatchObject({ name: 'Divya Kapoor', roll: '26BD1A660K', kitId: '26BD1A660K', profileComplete: false });
      expect(me.preset).toEqual({ name: 'Divya Kapoor', roll: '26BD1A660K' });
      expect(jar.cookies.ah_sid).toBeTruthy();
      // first sign-in = attendance: the attendee row, the sign-in points and sticker, as with kits
      expect(t.ctx.points.total(me.attendee.id)).toBe(10);
      expect(one(t.ctx.db, "SELECT 1 AS x FROM sticker_unlocks WHERE attendee_id = ? AND sticker_id = 'showed-up'", me.attendee.id)).toBeTruthy();
      const p = await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Divya Kapoor', roll: '26BD1A660K', nickname: 'divz', avatar: AVATAR });
      expect(p.statusCode).toBe(200);
      const row = await byRoll('26BD1A660K');
      expect(row).toMatchObject({ bound: true, attendee: { nickname: 'Divya Kapoor', profileComplete: true, points: 20 } });
      // signing in again on the same phone is fine and keeps one attendee
      expect((await idSignIn(jar, { payload: DIVYA_QR })).statusCode).toBe(200);
      expect(all(t.ctx.db, 'SELECT id FROM attendees')).toHaveLength(1);
      expect((await resolve(jar, DIVYA_QR)).json()).toMatchObject({ thisPhone: true });
    });

    it('a second phone is refused with a clear message; the desk unbinds and it works', async () => {
      const a = phone();
      expect((await idSignIn(a, { payload: DIVYA_QR })).statusCode).toBe(200);
      const b = phone();
      const r = await resolve(b, DIVYA_QR);
      expect(r.statusCode).toBe(409);
      expect((r.json() as J).error.code).toBe('id_bound');
      expect((r.json() as J).error.message).toMatch(/already signed in on another phone/);
      expect((await idSignIn(b, { payload: DIVYA_QR })).statusCode).toBe(409);
      // console unbind: the old phone is signed out and told so, the new phone gets in, same attendee
      const row = await byRoll('26BD1A660K');
      const cap = capture(t.ctx, { attendeeId: row.attendee.id, admin: false, screen: false });
      const u = await req(t.app, admin, 'POST', `/api/admin/participants/${row.id}/unbind`);
      expect(u.statusCode).toBe(200);
      expect((u.json() as J).bound).toBe(false);
      expect(cap.events.find((e) => e.type === 'session.revoked')?.data).toEqual({ reason: 'id-reset' });
      cap.unsub();
      expect((await req(t.app, a, 'GET', '/api/me')).statusCode).toBe(401);
      const s = await idSignIn(b, { payload: DIVYA_QR });
      expect(s.statusCode).toBe(200);
      expect((s.json() as J).attendee.id).toBe(row.attendee.id);
      expect(t.ctx.points.total(row.attendee.id)).toBe(10); // points stay, sign-in pays once
    });

    it('a shared last four shows a picker: names, year and section only, never a roll, phone or email', async () => {
      // even with a surname and a date that would point at one of them: names and dates are not used
      const r = await resolve(phone(), '0533-1-B-DATTA-CSE');
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as J;
      expect(body.kind).toBe('pick');
      expect(body.choices).toEqual([
        { id: expect.any(Number), name: 'Asha Verma', year: '2nd', section: 'CSE-A', bound: false },
        { id: expect.any(Number), name: 'Bhavya Datta', year: '1st', section: 'CSE-B', bound: false },
      ]);
      expect(r.body).not.toMatch(/BD1A|9000000|example\.com/);
      // signing in without a pick is refused: the phone must show the picker
      expect((await idSignIn(phone(), { payload: '0533-1-B-DATTA-CSE' })).json()).toMatchObject({ error: { code: 'need_pick' } });
      // tapping yourself: the normal confirm, then bind
      const jar = phone();
      const bhavya = body.choices[1].id;
      const one1 = (await resolve(jar, '0533-1-B-DATTA-CSE', bhavya)).json() as J;
      expect(one1).toMatchObject({ kind: 'one', id: bhavya, firstName: 'Bhavya', year: '1st', section: 'CSE-B' });
      expect(JSON.stringify(one1)).not.toMatch(/BD1A/);
      const s = await idSignIn(jar, { payload: '0533-1-B-DATTA-CSE', pick: bhavya });
      expect(s.statusCode, s.body).toBe(200);
      expect((s.json() as J).attendee).toMatchObject({ name: 'Bhavya Datta', roll: '26BD1A0533' });
    });

    it('the picker shows a bound person disabled, and the server refuses picking them', async () => {
      const first = (await resolve(phone(), '0577-1-C')).json() as J;
      const chetan = first.choices.find((c: J) => c.name === 'Chetan Rao').id;
      expect((await idSignIn(phone(), { payload: '0577-1-C', pick: chetan })).statusCode).toBe(200);
      const again = (await resolve(phone(), '0577-1-C')).json() as J;
      expect(again.choices.find((c: J) => c.id === chetan).bound).toBe(true);
      expect(again.choices.find((c: J) => c.name === 'Chandana Rao').bound).toBe(false);
      const picked = await resolve(phone(), '0577-1-C', chetan);
      expect(picked.statusCode).toBe(409);
      expect((picked.json() as J).error.code).toBe('id_bound');
      expect((await idSignIn(phone(), { payload: '0577-1-C', pick: chetan })).json()).toMatchObject({ error: { code: 'id_bound' } });
    });

    it('a tampered pick of someone whose last four does not match the card is refused', async () => {
      const divya = (await byRoll('26BD1A660K')).id;
      for (const pick of [divya, 99999]) {
        const r = await resolve(phone(), '0577-1-C', pick);
        expect(r.statusCode).toBe(400);
        expect((r.json() as J).error.code).toBe('bad_pick');
        expect((await idSignIn(phone(), { payload: '0577-1-C', pick })).statusCode).toBe(400);
      }
      expect((await byRoll('26BD1A660K')).bound).toBe(false);
    });

    it('name lookups are rate limited per network, misses included', async () => {
      // LOGIN_IP_PER_MIN=5: scans 5/min, name lookups 10 per 10 minutes. Calls 13 s apart, so only the name limit bites.
      const small = await makeApp({ env: { LOGIN_IP_PER_MIN: '5' } });
      try {
        const a = await adminJar(small.app);
        await req(small.app, a, 'POST', '/api/admin/participants/import', { csv: ROSTER });
        const codes: number[] = [];
        const bodies: string[] = [];
        for (let i = 0; i < 16; i++) {
          small.clock.advance(13_000);
          const r = await req(small.app, new JarClass(), 'POST', '/api/auth/id/resolve', { payload: i % 2 ? '0533-1-C' : `09${String(10 + i)}-1-C` });
          codes.push(r.statusCode);
          bodies.push(r.body);
        }
        const first429 = codes.indexOf(429);
        expect(first429).toBeGreaterThanOrEqual(10);
        expect(codes.slice(0, 10).every((c) => c === 200 || c === 404)).toBe(true);
        expect(bodies[first429]).toMatch(/ID lookups/);
        small.clock.advance(10 * 60_000);
        expect((await req(small.app, new JarClass(), 'POST', '/api/auth/id/resolve', { payload: DIVYA_QR })).statusCode).toBe(200);
      } finally {
        await small.close();
      }
    });

    it('not on the list, junk and a kit QR get kind, distinct errors', async () => {
      const nr = await resolve(phone(), '0999-12600-A-NOBODY-CSE-260908');
      expect(nr.statusCode).toBe(404);
      expect((nr.json() as J).error).toMatchObject({ code: 'not_registered', message: expect.stringMatching(/not on the list/) });
      for (const junk of ['hello there', 'https://afterhours.example/?kit=AH-001', '055W']) {
        const r = await resolve(phone(), junk);
        expect(r.statusCode, junk).toBe(400);
        expect((r.json() as J).error.code).toBe('bad_qr');
      }
    });

    it('stricter mode asks for the last 4 phone digits after a scan', async () => {
      const set = await req(t.app, admin, 'PUT', '/api/admin/idlogin/settings', { strictPhone: true });
      expect(set.json()).toEqual({ strictPhone: true });
      const jar = phone();
      expect((await resolve(jar, DIVYA_QR)).json()).toMatchObject({ needPhone: true });
      expect((await idSignIn(jar, { payload: DIVYA_QR })).statusCode).toBe(401);
      expect((await idSignIn(jar, { payload: DIVYA_QR, phone4: '1234' })).statusCode).toBe(401);
      expect((await idSignIn(jar, { payload: DIVYA_QR, phone4: '0055' })).statusCode).toBe(200);
      // the bound phone is not asked again
      expect((await resolve(jar, DIVYA_QR)).json()).toMatchObject({ needPhone: false, thisPhone: true });
      expect((await list()).settings).toEqual({ strictPhone: true });
    });

    it('off by default', async () => {
      expect((await list()).settings).toEqual({ strictPhone: false });
    });
  });

  describe('typed fallback: full roll + last 4 phone digits', () => {
    it('signs in with the right digits; O for zero in the roll is fine', async () => {
      const r = await rollSignIn(phone(), '26BD1A66OK', '0055');
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as J).attendee.roll).toBe('26BD1A660K');
    });

    it('a wrong roll and wrong digits look exactly the same', async () => {
      const unknown = await rollSignIn(phone(), '24BD1A0001', '0055');
      const wrong = await rollSignIn(phone(), '26BD1A660K', '9999');
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.body).toBe(wrong.body);
    });

    it('rate limits per roll, the same for a roll that exists and one that does not', async () => {
      const go = async (roll: string) => {
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) codes.push((await rollSignIn(phone(), roll, '1111')).statusCode);
        return codes;
      };
      expect(await go('26BD1A660K')).toEqual([401, 401, 401, 401, 401, 429]);
      expect(await go('24BD1A0001')).toEqual([401, 401, 401, 401, 401, 429]);
      // the right digits are refused too while the roll is locked
      expect((await rollSignIn(phone(), '26BD1A660K', '0055')).statusCode).toBe(429);
      t.clock.advance(6 * 60_000);
      expect((await rollSignIn(phone(), '26BD1A660K', '0055')).statusCode).toBe(200);
    });

    it('rate limits per network across rolls', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 32; i++) codes.push((await rollSignIn(phone(), `24BD1A${String(1000 + i)}`, '1111')).statusCode);
      expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    });

    it('a bound ID is only reported after the digits match', async () => {
      expect((await rollSignIn(phone(), '26BD1A660K', '0055')).statusCode).toBe(200);
      expect((await rollSignIn(phone(), '26BD1A660K', '9999')).statusCode).toBe(401);
      const r = await rollSignIn(phone(), '26BD1A660K', '0055');
      expect(r.statusCode).toBe(409);
      expect((r.json() as J).error.code).toBe('id_bound');
    });
  });

  describe('console roster', () => {
    it('import dedupes by roll and lists duplicates, conflicts and test entries', () => {
      const r = importParticipants(
        t.ctx,
        [
          'Farah Khan\t1st\tCSE-A\t26BD1A0581\t9000000077\tf@example.com',
          'Farah Khan\t1st\tCSE-A\t26bd1a0581\t+91 90000 00077\tf@example.com', // same person again
          'F Khan\t1st\tCSE-A\t26BD1A0581\t9000000088\tf2@example.com', // same roll, other name and phone
          'Gita (trial)\t1st\tCSE-A\t26BD1A0582\t9000000099\tg@example.com',
          'Divya Kapoor\t1st\tCSM-A\t26BD1A660K\t9000000055\tdivya@example.com', // already on the list
          'Someone Else\t1st\tCSM-A\t26BD1A66OK\t9000000000\tx@example.com', // already on the list, different person
          '\t1st\tCSE-A\t26BD1A0583\t9\tx', // no name
          'Odd Roll\t1st\tCSE-A\t??\t9\tx',
        ].join('\n'),
      );
      expect(r).toMatchObject({ added: 2, rows: 6, existing: 1 });
      expect(r.duplicates).toEqual([{ line: 2, roll: '26BD1A0581', name: 'Farah Khan' }]);
      expect(r.conflicts).toEqual([
        { line: 3, roll: '26BD1A0581', name: 'F Khan', keptName: 'Farah Khan', differs: ['name', 'phone'], existing: false },
        { line: 6, roll: '26BD1A66OK', name: 'Someone Else', keptName: 'Divya Kapoor', differs: ['name', 'phone'], existing: true },
      ]);
      expect(r.skipped.map((s) => s.line)).toEqual([7, 8]);
      expect(r.flagged).toEqual([{ roll: '26BD1A0582', name: 'Gita (trial)', reason: 'probable test entry' }]);
      const notes = Object.fromEntries(all<{ roll: string; note: string }>(t.ctx.db, 'SELECT roll, note FROM participants').map((p) => [p.roll, p.note]));
      expect(notes['26BD1A0581']).toMatch(/roll also given by "F Khan" \(phone ending 88\)/);
      expect(notes['26BD1A660K']).toMatch(/roll also given by "Someone Else"/);
      expect(notes['26BD1A0582']).toBe('probable test entry');
      // importing the same file again adds nobody
      expect(importParticipants(t.ctx, ROSTER)).toMatchObject({ added: 0, existing: 6, conflicts: [] });
    });

    it('header names are read loosely and decide the column order', () => {
      const { rows } = parseParticipantCsv('Roll No,Full Name,Mobile Number\n26BD1A0590,Hari Prasad,9000000101\n');
      expect(rows).toEqual([{ line: 2, input: { name: 'Hari Prasad', roll: '26BD1A0590', phone: '9000000101', year: null, section: null, email: null } }]);
    });

    it('roster kits stay out of the kits panel and cannot be used with a kit password', async () => {
      const kits = (await req(t.app, admin, 'GET', '/api/admin/kits')).json() as J;
      expect(kits.stats.total).toBe(0);
      expect((await req(t.app, phone(), 'POST', '/api/auth/signin', { kitId: '26BD1A660K', password: '!roster' })).statusCode).toBe(400);
    });

    it('walk-in: add, sign in by scan, edit, cannot remove once in, export fields present', async () => {
      const add = await req(t.app, admin, 'POST', '/api/admin/participants', { name: 'Walk In', roll: '26bd1a0599', phone: '9000000123' });
      expect(add.statusCode, add.body).toBe(200);
      expect(add.json()).toMatchObject({ roll: '26BD1A0599', source: 'walkin', kitId: '26BD1A0599' });
      expect((await req(t.app, admin, 'POST', '/api/admin/participants', { name: 'Again', roll: '26BD1A0599' })).statusCode).toBe(409);
      const s = await idSignIn(phone(), { payload: '0599-1-A-IN-CSE-260801' });
      expect(s.statusCode).toBe(200);
      const id = (add.json() as J).id;
      const ed = await req(t.app, admin, 'PUT', `/api/admin/participants/${id}`, { name: 'Walk In Fixed', roll: '26BD1A0599', phone: '9000000124' });
      expect(ed.json()).toMatchObject({ name: 'Walk In Fixed', phone: '9000000124', kitId: '26BD1A0599' });
      expect((await req(t.app, admin, 'DELETE', `/api/admin/participants/${id}`)).statusCode).toBe(409);
      const row = (await list()).participants.find((p: J) => p.id === id);
      expect(row.attendee).toMatchObject({ firstSignInAt: t.clock.now(), points: 10 });
      // someone who never signed in can be removed, and their kit goes with them
      const gone = await byRoll('25BD1A0577');
      expect((await req(t.app, admin, 'DELETE', `/api/admin/participants/${gone.id}`)).statusCode).toBe(200);
      expect(one(t.ctx.db, "SELECT 1 AS x FROM kits WHERE id = '25BD1A0577'")).toBeUndefined();
    });

    it('desk lookup: a scanned card, a roll, part of a roll, a name', async () => {
      const look = async (q: string) => (await req(t.app, admin, 'POST', '/api/admin/desk/lookup', { q })).json() as J;
      const scan = await look('0533-1-B-DATTA-CSE');
      expect(scan.read).toBe('qr');
      expect(scan.matches.map((m: J) => m.roll).sort()).toEqual(['25BD1A0533', '26BD1A0533']);
      expect(scan.pickId).toBeNull(); // two share it: the phone shows its picker
      expect((await look('26bd1a66ok')).matches.map((m: J) => m.roll)).toEqual(['26BD1A660K']);
      expect((await look('0577')).matches).toHaveLength(2);
      expect((await look('kapoor')).matches.map((m: J) => m.roll)).toEqual(['26BD1A660K']);
      expect((await look('zzzz')).matches).toEqual([]);
    });

    it('console routes need the PIN', async () => {
      expect((await req(t.app, phone(), 'GET', '/api/admin/participants')).statusCode).toBe(401);
      expect((await req(t.app, phone(), 'POST', '/api/admin/participants/import', { csv: ROSTER })).statusCode).toBe(401);
      expect((await req(t.app, phone(), 'PUT', '/api/admin/idlogin/settings', { strictPhone: true })).statusCode).toBe(401);
    });
  });

  describe('kits keep working', () => {
    it('kit sign-in, the one-phone rule and reset are unchanged', async () => {
      const [kit] = await makeKits(t.app, 1);
      const a = await signedInAttendee(t.app, kit!, 'kitty');
      expect(a.id).toBeGreaterThan(0);
      const b = phone();
      const r = await req(t.app, b, 'POST', '/api/auth/signin', kit);
      expect((r.json() as J).error.code).toBe('kit_bound');
      expect((await req(t.app, admin, 'POST', `/api/admin/kits/${kit!.kitId}/reset`, {})).statusCode).toBe(200);
      expect((await req(t.app, b, 'POST', '/api/auth/signin', kit)).statusCode).toBe(200);
      const kits = (await req(t.app, admin, 'GET', '/api/admin/kits')).json() as J;
      expect(kits.stats).toMatchObject({ total: 1, signedIn: 1 });
      // a roster kit cannot be reset from the kits panel
      expect((await req(t.app, admin, 'POST', '/api/admin/kits/26BD1A660K/reset', {})).statusCode).toBe(400);
    });
  });

  describe('a QR-login attendee plays like anyone else', () => {
    async function divya() {
      const jar = phone();
      expect((await idSignIn(jar, { payload: DIVYA_QR })).statusCode).toBe(200);
      const p = await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Divya Kapoor', roll: '26BD1A660K', nickname: 'divz', avatar: AVATAR });
      return { jar, id: (p.json() as J).attendee.id as number };
    }

    it('plays a per-kit slip stop with the words of their own roster kit', async () => {
      const d = await divya();
      const h = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, jar: Jar = admin) => {
        const r = await req(t.app, jar, method, `/api/hunt${url}`, body);
        expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
        return r.json() as J;
      };
      const pool = ['ALPHA', 'BRAVO', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA'];
      const tr = (await h('POST', '/admin/trails', { title: 'slips', kind: 'morse', orderMode: 'graph' })).trail.id;
      const setId = (await h('POST', `/admin/slip-sets?trail=${tr}`, { title: 'kit', mode: 'per_kit', pool })).sets[0].id;
      const end = (await h('POST', `/admin/stops?trail=${tr}`, { title: 'end', clue: 'c', answers: ['x'], finale: true })).stops.at(-1);
      const slips = await h('POST', `/admin/slip-sets/${setId}/slips`, {
        slipNo: 1,
        label: 'one',
        readings: [
          { orientation: 'bottom', word: null, outcome: 'next', targetStopId: end.id },
          { orientation: 'right', word: null, outcome: 'decoy' },
          { orientation: 'top', word: null, outcome: 'decoy' },
          { orientation: 'left', word: null, outcome: 'decoy' },
        ],
      });
      const slipStop = (await h('POST', `/admin/stops?trail=${tr}`, { title: 'slip stop', clue: 'scan slip 1', slipId: slips.sets[0].slips[0].id })).stops.at(-1);
      await h('PUT', `/admin/order?trail=${tr}`, { ids: [slipStop.id, end.id] });
      await h('PUT', `/admin/state?trail=${tr}`, { status: 'open' });
      // the print sheet has a slip for the roster kit, labelled with the roll
      const sheet = await h('GET', `/admin/slip-print?set=${setId}`);
      const mine = sheet.slips.find((s: J) => s.kitId === '26BD1A660K');
      expect(mine).toBeTruthy();
      await h('POST', '/start', { trailId: tr }, d.jar);
      const res = await h('POST', '/slip', { stopId: slipStop.id, text: mine.edges.bottom.word }, d.jar);
      expect(res.outcome).toBe('next');
      expect(res.me.current.stopId).toBe(end.id);
    });

    it('gets 2 free mocktails at the stall', async () => {
      const d = await divya();
      const ov = (await req(t.app, admin, 'GET', '/api/stalls/admin/overview')).json() as J;
      const bar = ov.stalls[0];
      const mocktail = bar.items[0].id;
      const shop = new JarClass();
      expect((await req(t.app, shop, 'POST', '/api/stalls/shop/signin', { code: bar.code })).statusCode).toBe(200);
      const hand = async (k: string) => {
        const token = ((await req(t.app, d.jar, 'GET', '/api/stalls/qr')).json() as J).token;
        const s = await req(t.app, shop, 'POST', '/api/stalls/shop/scan', { input: token });
        expect(s.statusCode, s.body).toBe(200);
        expect((s.json() as J).attendee.nickname).toBe('Divya Kapoor');
        return req(t.app, shop, 'POST', '/api/stalls/shop/commit', { ticket: (s.json() as J).ticket, key: k, lines: [{ itemId: mocktail, qty: 1 }] });
      };
      const r1 = await hand('key-000001-abcdefgh');
      expect((r1.json() as J).freeLeft).toBe(1);
      const r2 = await hand('key-000002-abcdefgh');
      expect((r2.json() as J).freeLeft).toBe(0);
      expect((r2.json() as J).pointsSpent).toBe(0);
      // the console's stall lookup by kit id takes the roll
      const look = await req(t.app, admin, 'GET', '/api/stalls/admin/lookup?kit=26bd1a660k');
      expect(look.json()).toMatchObject({ nickname: 'Divya Kapoor', allowance: { used: 2, left: 0 } });
    });

    it('appears on the leaderboard', async () => {
      const d = await divya();
      const [kit] = await makeKits(t.app, 1);
      await signedInAttendee(t.app, kit!, 'kitty');
      t.ctx.points.award({ attendeeId: d.id, source: 'test', ref: 'boost', points: 30 });
      const lb = t.ctx.points.leaderboard(10, d.id);
      expect(lb.entries.map((e) => [e.nickname, e.total])).toEqual([
        ['Divya Kapoor', 50],
        ['kitty', 20],
      ]);
      expect(lb.me?.rank).toBe(1);
    });
  });

  describe('door gate (/gate)', () => {
    it('needs GATE_PIN; wrong PIN is refused, admin can also access, gate cannot access admin', async () => {
      expect((await req(t.app, phone(), 'GET', '/api/gate/stats')).statusCode).toBe(401);
      expect((await req(t.app, phone(), 'POST', '/api/gate/lookup', { q: DIVYA_QR })).statusCode).toBe(401);
      expect((await req(t.app, phone(), 'POST', '/api/gate/session', { pin: '0000' })).statusCode).toBe(401);

      const gate = await gateJar(t.app);
      expect((await req(t.app, gate, 'GET', '/api/gate/session')).json()).toEqual({ role: 'gate' });
      expect((await req(t.app, gate, 'GET', '/api/gate/stats')).statusCode).toBe(200);
      // gate coordinator cannot access admin console endpoints
      expect((await req(t.app, gate, 'GET', '/api/admin/participants')).statusCode).toBe(401);
      // admin can also use gate endpoints
      expect((await req(t.app, admin, 'GET', '/api/gate/stats')).statusCode).toBe(200);
      // lock / sign out works
      expect((await req(t.app, gate, 'DELETE', '/api/gate/session')).statusCode).toBe(200);
      expect((await req(t.app, gate, 'GET', '/api/gate/stats')).statusCode).toBe(401);
    });

    it('scans ID QR, lateral-entry full roll, duplicate suffix, and name; hides full phone and email', async () => {
      // add a lateral entry student to verify end-to-end
      expect((await req(t.app, admin, 'POST', '/api/admin/participants', { name: 'Kiran Lateral', roll: '25BD5A0502', year: '2nd', section: 'CSE-A', phone: '9876543210', email: 'kiran@example.com' })).statusCode).toBe(200);
      const gate = await gateJar(t.app);

      const look = async (q: string) => {
        const r = await req(t.app, gate, 'POST', '/api/gate/lookup', { q });
        expect(r.statusCode, r.body).toBe(200);
        return r;
      };

      const qrRes = await look(DIVYA_QR);
      expect(qrRes.body).not.toContain('9000000055');
      expect(qrRes.body).not.toContain('divya@example.com');
      expect(qrRes.json()).toMatchObject({
        read: 'qr',
        qrSuffix: '660K',
        stats: { total: 7, entered: 0 },
        matches: [{ roll: '26BD1A660K', name: 'Divya Kapoor', phoneLast4: '0055', gateEnteredAt: null }],
      });

      const latRes = await look('25BD5A0502');
      expect(latRes.json()).toMatchObject({
        read: 'roll',
        matches: [{ roll: '25BD5A0502', name: 'Kiran Lateral', phoneLast4: '3210' }],
      });

      const dupRes = await look('0533-12600-B-DATTA-CSE-260908');
      expect(dupRes.json().matches.map((m: J) => m.roll).sort()).toEqual(['25BD1A0533', '26BD1A0533']);

      const nameRes = await look('kapoor');
      expect(nameRes.json().matches.map((m: J) => m.roll)).toEqual(['26BD1A660K']);

      const missRes = await look('0999-12600-A-NOBODY-CSE-260908');
      expect(missRes.json()).toMatchObject({ read: 'qr', qrSuffix: '0999', matches: [] });
    });

    it('marks entered once, flags already entered on second tap, broadcasts live, and supports undo', async () => {
      const gate = await gateJar(t.app);
      const divya = await byRoll('26BD1A660K');
      const cap = capture(t.ctx, { attendeeId: null, admin: false, screen: false, gate: true });

      const first = await req(t.app, gate, 'POST', `/api/gate/participants/${divya.id}/enter`, {});
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        newlyEntered: true,
        stats: { total: 6, entered: 1 },
        person: { id: divya.id, roll: '26BD1A660K', gateEnteredAt: t.clock.now() },
      });
      expect(cap.events.find((e) => e.type === 'gate.changed')?.data).toEqual({
        entered: 1,
        total: 6,
        participantId: divya.id,
        enteredAt: t.clock.now(),
      });

      // second tap (e.g. another coordinator or rescan) does not overwrite timestamp and reports newlyEntered = false
      const enteredAt = t.clock.now();
      t.clock.advance(60_000);
      const second = await req(t.app, gate, 'POST', `/api/gate/participants/${divya.id}/enter`, {});
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        newlyEntered: false,
        stats: { total: 6, entered: 1 },
        person: { id: divya.id, gateEnteredAt: enteredAt },
      });

      const stats = (await req(t.app, gate, 'GET', '/api/gate/stats')).json() as J;
      expect(stats).toMatchObject({
        total: 6,
        entered: 1,
        recent: [{ id: divya.id, roll: '26BD1A660K', name: 'Divya Kapoor', gateEnteredAt: enteredAt }],
      });

      // undo clears entry and broadcasts
      const undone = await req(t.app, gate, 'POST', `/api/gate/participants/${divya.id}/undo`, {});
      expect(undone.statusCode).toBe(200);
      expect(undone.json()).toMatchObject({
        stats: { total: 6, entered: 0 },
        person: { id: divya.id, gateEnteredAt: null },
      });
      expect(cap.events.filter((e) => e.type === 'gate.changed')).toHaveLength(2);
      cap.unsub();
    });
  });
});

describe('their own names, no usernames', () => {
  let t: TestApp;
  let admin: Jar;
  beforeEach(async () => {
    t = await makeApp();
    admin = await adminJar(t.app);
    await req(t.app, admin, 'POST', '/api/admin/participants/import', { csv: ROSTER });
  });
  afterEach(async () => t.close());

  it('someone on the list is shown by their registered name and roll, whatever the phone sends', async () => {
    const jar = new JarClass();
    expect((await req(t.app, jar, 'POST', '/api/auth/id/signin', { payload: DIVYA_QR })).statusCode).toBe(200);
    const p = await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Someone Else', roll: '25BD1A0000', nickname: 'xx_slayer', avatar: AVATAR });
    expect(p.statusCode, p.body).toBe(200);
    expect((p.json() as J).attendee).toMatchObject({ name: 'Divya Kapoor', roll: '26BD1A660K', nickname: 'Divya Kapoor' });
    // no nickname at all is fine too
    const q = await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Divya Kapoor', roll: '26BD1A660K', avatar: AVATAR });
    expect(q.statusCode, q.body).toBe(200);
  });

  it('a printed kit (not on the list) is shown by the name typed when no nickname is sent', async () => {
    const [kit] = await makeKits(t.app, 1);
    const jar = new JarClass();
    expect((await req(t.app, jar, 'POST', '/api/auth/signin', { kitId: kit!.kitId, password: kit!.password })).statusCode).toBe(200);
    const p = await req(t.app, jar, 'PUT', '/api/me/profile', { name: 'Walk In', roll: 'WALKIN1', avatar: AVATAR });
    expect(p.statusCode, p.body).toBe(200);
    expect((p.json() as J).attendee.nickname).toBe('Walk In');
  });
});
